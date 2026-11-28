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
/** A Graph de conversas é LENTA (medido: ~5 s a lista leve, ~13 s com mensagens juntas): o prazo de cada chamada é folgado. */
const TIMEOUT_MS = 25_000;
/** Conversas olhadas por rodada e mensagens lidas por conversa. */
const CONVERSAS_NA_LISTA = 20;
const MENSAGENS_POR_CONVERSA = 10;
/** Conversas com mensagens lidas por rodada: o cron tem prazo (45 s) e cada leitura é uma ida à Meta. */
const CONVERSAS_LIDAS_POR_RODADA = 4;
/** Depois deste tempo a rodada para de abrir conversas novas (a marca fica onde parou; a próxima continua). */
const ORCAMENTO_DA_RODADA_MS = 28_000;
/**
 * Folga da marca na leitura das mensagens de uma conversa: se uma rodada parou no meio (prazo ou
 * teto de conversas), as não lidas ficam com mensagens um pouco ANTES da marca nova. Reler essa
 * folga é inofensivo — a ingestão é idempotente por `external_id`.
 */
const FOLGA_DA_MARCA_MS = 10 * 60 * 1000;
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
  id?: string;
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

async function chamar<T>(token: string, caminho: string, q: URLSearchParams): Promise<T> {
  const resposta = await fetch(`${graphBaseUrl()}/${caminho}?${q.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!resposta.ok) throw new Error(`conversas_http_${resposta.status}`);
  return (await resposta.json().catch(() => ({}))) as T;
}

/** A lista LEVE: só id e quando cada conversa mexeu pela última vez. */
async function conversasQueMexeram(token: string, igId: string, desde: Date): Promise<{ id: string; mexeuEm: Date }[]> {
  const q = new URLSearchParams({ platform: "instagram", limit: String(CONVERSAS_NA_LISTA), fields: "id,updated_time" });
  const corpo = await chamar<{ data?: ConversaDaGraph[] }>(token, `${encodeURIComponent(igId)}/conversations`, q);
  const lista: { id: string; mexeuEm: Date }[] = [];
  for (const c of corpo.data ?? []) {
    const mexeuEm = c.updated_time ? new Date(c.updated_time) : null;
    if (!c.id || !mexeuEm || Number.isNaN(mexeuEm.getTime()) || mexeuEm <= desde) continue;
    lista.push({ id: c.id, mexeuEm });
  }
  // Das mais antigas para as mais novas: se a rodada parar no meio, o que ficou é o mais novo.
  return lista.sort((a, b) => a.mexeuEm.getTime() - b.mexeuEm.getTime());
}

async function mensagensDaConversa(token: string, conversaId: string): Promise<MensagemDaGraph[]> {
  const q = new URLSearchParams({
    fields: `messages.limit(${MENSAGENS_POR_CONVERSA}){id,message,created_time,from,attachments}`,
  });
  const corpo = await chamar<ConversaDaGraph>(token, encodeURIComponent(conversaId), q);
  return corpo.messages?.data ?? [];
}

/** Uma conta: busca, entrega as DMs novas e devolve a nova marca d'água. Lança se a Meta falhar. */
export async function buscarDmsDaConta(
  db: SupabaseClient,
  sessao: { id: string; organizationId: string; igId: string; token: string; desde: Date },
  inicio = Date.now(),
): Promise<{ entregues: number; ate: Date }> {
  const mexeram = await conversasQueMexeram(sessao.token, sessao.igId, sessao.desde);
  let ate = sessao.desde;
  let entregues = 0;
  let lidas = 0;

  for (const conversa of mexeram) {
    if (lidas >= CONVERSAS_LIDAS_POR_RODADA || Date.now() - inicio > ORCAMENTO_DA_RODADA_MS) break;
    lidas += 1;
    const novas: { m: MensagemDaGraph; quando: Date }[] = [];
    for (const m of await mensagensDaConversa(sessao.token, conversa.id)) {
      if (!m.id || !m.from?.id || m.from.id === sessao.igId || !m.created_time) continue;
      const quando = new Date(m.created_time);
      if (Number.isNaN(quando.getTime()) || quando.getTime() <= sessao.desde.getTime() - FOLGA_DA_MARCA_MS) continue;
      novas.push({ m, quando });
    }
    // Do mais antigo para o mais novo: a marca só avança sobre o que de fato entrou.
    novas.sort((a, b) => a.quando.getTime() - b.quando.getTime());
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
      if (quando > ate) ate = quando;
    }
    // A conversa foi lida inteira: a marca pode ir até quando ela mexeu pela última vez.
    if (conversa.mexeuEm > ate) ate = conversa.mexeuEm;
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
