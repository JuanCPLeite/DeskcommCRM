/**
 * A BUSCA de DMs do Instagram pela API — a rede de segurança do webhook.
 *
 * A Meta nem sempre entrega o aviso de `messages` (medido: comentário chega, DM não, e a API de
 * conversas enxerga a mensagem). Então, a cada rodada do cron, o CRM PERGUNTA à Meta pelas
 * conversas que mexeram desde a última vez e entrega cada DM RECEBIDA ao mesmo caminho do
 * webhook (`ingestMetaSocial`), que já é idempotente por `external_id`: se o aviso um dia
 * voltar a chegar, a mesma mensagem não vira duas.
 *
 * Só DMs RECEBIDAS entram. O que a própria conta enviou (pelo CRM ou pelo app do Instagram) não
 * é lido: o do CRM já foi gravado no envio, e gravar de novo por outro id duplicaria a resposta.
 *
 * A marca d'água (`metadata.meta_social_busca_ate`) só avança até a mensagem mais nova que ENTROU:
 * se a rodada falha no meio, a próxima recomeça dali, sem pular nada.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";

import { graphBaseUrl } from "../meta/graph-base";
import { ingestMetaSocial } from "./ingest";

const PROVIDER = "meta_social";
const TIMEOUT_MS = 15_000;
/** Conversas e mensagens lidas por conta e por rodada. Cada rodada é de 1 minuto: sobra folga. */
const CONVERSAS_POR_RODADA = 25;
const MENSAGENS_POR_CONVERSA = 10;
/** Sessão sem marca d'água começa a olhar daqui para trás: não importa o histórico antigo da conta. */
const JANELA_INICIAL_MS = 10 * 60 * 1000;

export interface ResultadoDaBusca {
  contas: number;
  mensagens: number;
  falhas: number;
}

interface MensagemDaGraph {
  id?: string;
  message?: string;
  created_time?: string;
  from?: { id?: string };
  attachments?: { data?: { image_data?: { url?: string }; video_data?: { url?: string }; file_url?: string }[] };
}

interface ConversaDaGraph {
  updated_time?: string;
  messages?: { data?: MensagemDaGraph[] };
}

function anexosDe(m: MensagemDaGraph): { tipo: string; url: string }[] {
  const saida: { tipo: string; url: string }[] = [];
  for (const a of m.attachments?.data ?? []) {
    if (a.image_data?.url) saida.push({ tipo: "image", url: a.image_data.url });
    else if (a.video_data?.url) saida.push({ tipo: "video", url: a.video_data.url });
    else if (a.file_url) saida.push({ tipo: "file", url: a.file_url });
  }
  return saida;
}

async function lerConversas(token: string, igId: string): Promise<ConversaDaGraph[]> {
  const q = new URLSearchParams({
    platform: "instagram",
    limit: String(CONVERSAS_POR_RODADA),
    fields: `updated_time,messages.limit(${MENSAGENS_POR_CONVERSA}){id,message,created_time,from,attachments}`,
  });
  const resposta = await fetch(`${graphBaseUrl()}/${encodeURIComponent(igId)}/conversations?${q.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!resposta.ok) throw new Error(`conversas_http_${resposta.status}`);
  const corpo = (await resposta.json().catch(() => ({}))) as { data?: ConversaDaGraph[] };
  return corpo.data ?? [];
}

/** Uma conta: busca, entrega as DMs novas e devolve a nova marca d'água. Lança se a Meta falhar. */
export async function buscarDmsDaConta(
  db: SupabaseClient,
  sessao: { id: string; organizationId: string; igId: string; token: string; desde: Date },
): Promise<{ entregues: number; ate: Date }> {
  const conversas = await lerConversas(sessao.token, sessao.igId);
  const novas: { m: MensagemDaGraph; quando: Date }[] = [];
  for (const c of conversas) {
    for (const m of c.messages?.data ?? []) {
      if (!m.id || !m.from?.id || m.from.id === sessao.igId || !m.created_time) continue;
      const quando = new Date(m.created_time);
      if (Number.isNaN(quando.getTime()) || quando <= sessao.desde) continue;
      novas.push({ m, quando });
    }
  }
  // Do mais antigo para o mais novo: a marca só avança sobre o que de fato entrou.
  novas.sort((a, b) => a.quando.getTime() - b.quando.getTime());

  let ate = sessao.desde;
  let entregues = 0;
  for (const { m, quando } of novas) {
    const r = await ingestMetaSocial(
      db,
      {
        tipo: "mensagem",
        contaId: sessao.igId,
        participanteId: m.from!.id!,
        mid: m.id!,
        texto: m.message ?? null,
        anexos: anexosDe(m),
        enviadoEm: quando,
      },
      { id: sessao.id, organizationId: sessao.organizationId },
    );
    if (r.status !== "ignored") entregues += 1;
    ate = quando;
  }
  return { entregues, ate };
}

/** A rodada inteira: todas as contas ativas. Falha de uma conta não derruba as outras. */
export async function buscarDmsNovas(db: SupabaseClient, agora = new Date()): Promise<ResultadoDaBusca> {
  const { data, error } = await db
    .from("channel_sessions")
    .select("id, organization_id, social_account_id, social_token_encrypted, metadata")
    .eq("provider", PROVIDER)
    .is("archived_at", null)
    .not("social_token_encrypted", "is", null)
    .limit(100);
  if (error) throw new Error(`busca_meta_social_sessoes:${error.code ?? "sem_codigo"}`);

  const out: ResultadoDaBusca = { contas: 0, mensagens: 0, falhas: 0 };
  for (const s of data ?? []) {
    out.contas += 1;
    const organizationId = s.organization_id as string;
    try {
      const token = await decryptWebhookSecret(db, s.social_token_encrypted as string);
      if (!token) throw new Error("token_indisponivel");
      const metadata = (s.metadata as Record<string, unknown> | null) ?? {};
      const marca = typeof metadata.meta_social_busca_ate === "string" ? new Date(metadata.meta_social_busca_ate) : null;
      const desde = marca && !Number.isNaN(marca.getTime()) ? marca : new Date(agora.getTime() - JANELA_INICIAL_MS);

      const { entregues, ate } = await buscarDmsDaConta(db, {
        id: s.id as string,
        organizationId,
        igId: s.social_account_id as string,
        token,
        desde,
      });
      out.mensagens += entregues;

      // A marca avança só se algo entrou ou se ela ainda não existia (a primeira rodada fixa o ponto de partida).
      if (ate.getTime() !== desde.getTime() || !marca) {
        const { error: eMarca } = await db
          .from("channel_sessions")
          .update({ metadata: { ...metadata, meta_social_busca_ate: ate.toISOString() } })
          .eq("organization_id", organizationId)
          .eq("id", s.id as string);
        if (eMarca) throw new Error(`marca_nao_gravada:${eMarca.code ?? "sem_codigo"}`);
      }
    } catch (err) {
      out.falhas += 1;
      // O motivo é NOSSO (código de erro ou status HTTP), nunca o token nem o corpo da Meta.
      logger.warn("[meta-social.busca] conta falhou", {
        organization_id: organizationId,
        channel_session_id: s.id as string,
        erro: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
      });
    }
  }
  return out;
}
