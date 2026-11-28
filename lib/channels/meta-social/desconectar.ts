/**
 * Desligar uma conta Instagram do app Meta da instalação, no momento em que a
 * organização a desconecta: desfaz a assinatura de webhook da conta, para a Meta
 * parar de entregar DMs de uma conta que o CRM não atende mais.
 *
 * BEST-EFFORT: nunca lança. A desconexão que a pessoa pediu NÃO pode falhar porque
 * a Meta está fora do ar — o resultado vai para a auditoria (`desfeito`,
 * `sem_credencial` ou `falhou`) e o token cifrado é zerado pela rota de qualquer
 * jeito. Uma assinatura que sobra do lado da Meta é inofensiva: o webhook responde
 * 200 e ignora a conta que nenhuma organização tem ativa.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";

import { desassinarWebhooks } from "./graph";

export type DesligamentoNaMeta = "desfeito" | "sem_credencial" | "falhou";

export async function desligarContaNaMeta(
  db: SupabaseClient,
  organizationId: string,
  sessionId: string,
): Promise<DesligamentoNaMeta> {
  try {
    const { data, error } = await db
      .from("channel_sessions")
      .select("social_account_id, meta_social_token_encrypted")
      .eq("organization_id", organizationId)
      .eq("id", sessionId)
      .maybeSingle();
    if (error) return "falhou";
    const cifrado = data?.meta_social_token_encrypted as string | null | undefined;
    const conta = data?.social_account_id as string | null | undefined;
    if (!cifrado || !conta) return "sem_credencial";
    const token = await decryptWebhookSecret(db, cifrado);
    if (!token) return "sem_credencial";
    return (await desassinarWebhooks(token, conta)) ? "desfeito" : "falhou";
  } catch (err) {
    logger.warn("[meta-social] falha ao desfazer a assinatura do webhook na Meta", {
      organization_id: organizationId,
      channel_session_id: sessionId,
      erro: err instanceof Error ? err.message : String(err),
    });
    return "falhou";
  }
}
