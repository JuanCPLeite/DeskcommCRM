/**
 * Os números oficiais ATIVOS de uma empresa — contar e listar.
 *
 * Um lugar só porque três chamadores precisam da MESMA régua: a rota de conexão por
 * token, a do Embedded Signup e a tela. Duas contagens que discordam sobre o que é
 * "ativo" são como o teto de números da empresa (`organization_meta_access`) passa a
 * valer para uma porta e não para a outra.
 *
 * Canal ARQUIVADO não conta: a linha sobrevive à exclusão só como âncora das FKs, e
 * contá-la prenderia a empresa abaixo do teto por causa de números que ela já
 * excluiu. Todo acesso filtra `organization_id` — o client é service role e bypassa
 * RLS (varredura `canal-consulta-por-organizacao.test.ts`).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ARCHIVED_AT, queryTolerantToMissingArchived } from "@/lib/channels/archived";
import { CHANNEL_PROVIDER_META } from "@/lib/channels/capabilities";

/** Quantos números oficiais ativos a empresa tem. `null` = não deu para contar. */
export async function contarNumerosAtivos(
  admin: SupabaseClient,
  organizationId: string,
): Promise<number | null> {
  const base = () =>
    admin
      .from("channel_sessions")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .eq("provider", CHANNEL_PROVIDER_META);
  const r = await queryTolerantToMissingArchived(
    () => base().is(ARCHIVED_AT, null),
    () => base(),
  );
  if (r.error) return null;
  return (r as { count?: number | null }).count ?? 0;
}

/**
 * O andamento do histórico da coexistência de um número — só o que a tela mostra.
 * `null` no número = não é coexistência, ou a Meta ainda não entregou nada.
 */
export interface HistoricoDoNumero {
  /** Último percentual informado pela Meta (0–100); `null` = nenhum pedaço chegou. */
  progresso: number | null;
  /** Mensagens do histórico que já estão no CRM. */
  mensagens: number;
  concluido: boolean;
  /** Por que parou ou o que ficou de fora. Texto curto, sem conteúdo de conversa. */
  erro: string | null;
}

export interface NumeroOficial {
  id: string;
  displayName: string | null;
  phoneNumber: string | null;
  status: string | null;
  phoneNumberId: string | null;
  wabaId: string | null;
  /** Só de número em coexistência que já recebeu (ou teve recusado) o histórico. */
  historico: HistoricoDoNumero | null;
}

/**
 * O andamento de cada número, por sessão. Mesma regra da lista: é um EXTRA, e a
 * falha de leitura vira "sem andamento" — nunca esconde o número.
 */
async function andamentoDoHistorico(
  admin: SupabaseClient,
  organizationId: string,
): Promise<Map<string, HistoricoDoNumero>> {
  const { data, error } = await admin
    .from("channel_session_meta_signup")
    .select(
      "channel_session_id, historico_progresso, historico_mensagens, historico_concluido_em, historico_erro, historico_atualizado_em",
    )
    .eq("organization_id", organizationId);
  const mapa = new Map<string, HistoricoDoNumero>();
  if (error || !Array.isArray(data)) return mapa;
  for (const l of data as Array<{
    channel_session_id: string;
    historico_progresso: number | null;
    historico_mensagens: number | null;
    historico_concluido_em: string | null;
    historico_erro: string | null;
    historico_atualizado_em: string | null;
  }>) {
    // Sem nenhum pedaço (nem recusa) a Meta ainda não falou: não há o que mostrar.
    if (!l.historico_atualizado_em) continue;
    mapa.set(l.channel_session_id, {
      progresso: l.historico_progresso ?? null,
      mensagens: l.historico_mensagens ?? 0,
      concluido: l.historico_concluido_em !== null,
      erro: l.historico_erro ?? null,
    });
  }
  return mapa;
}

/**
 * Do mais antigo ao mais novo. Nunca devolve token — nem cifrado. Falha de leitura
 * vira lista vazia: é um EXTRA da resposta, e a tela já descreve a primeira conexão
 * pelos campos de sempre.
 */
export async function listarNumerosOficiais(
  admin: SupabaseClient,
  organizationId: string,
): Promise<NumeroOficial[]> {
  const listar = () =>
    admin
      .from("channel_sessions")
      .select("id, display_name, phone_number, status, meta_phone_number_id, meta_waba_id")
      .eq("organization_id", organizationId)
      .eq("provider", CHANNEL_PROVIDER_META)
      .order("created_at", { ascending: true });
  const { data, error } = await queryTolerantToMissingArchived(
    () => listar().is(ARCHIVED_AT, null),
    () => listar(),
  );
  if (error || !Array.isArray(data)) return [];
  const andamento = await andamentoDoHistorico(admin, organizationId);
  return (data as Array<Record<string, string | null>>).map((l) => ({
    id: String(l.id),
    displayName: l.display_name ?? null,
    phoneNumber: l.phone_number ?? null,
    status: l.status ?? null,
    phoneNumberId: l.meta_phone_number_id ?? null,
    wabaId: l.meta_waba_id ?? null,
    historico: andamento.get(String(l.id)) ?? null,
  }));
}
