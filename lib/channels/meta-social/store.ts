/**
 * O acesso ao banco do canal DIRETO de Instagram/Facebook (`channel_sessions`
 * com `provider = 'meta_social'`). Só o servidor chama isto, com o admin client —
 * por isso toda função recebe a organização e filtra por ela, e a única que lê
 * sem filtrar (`sessaoAtivaDaConta`) existe para responder à pergunta
 * "esta conta já pertence a alguém?", devolvendo a organização dona.
 */
import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { metadataInicialDoCanal } from "@/lib/ai/elegibilidade/pre-go-live";
import { lerLimiteEstourado } from "@/lib/cobranca/limites";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";

const PROVIDER = "meta_social";

export interface SessaoDaConta {
  id: string;
  organizationId: string;
}

/** A sessão ATIVA (não arquivada) que já tem esta conta, de qualquer organização. */
export async function sessaoAtivaDaConta(db: SupabaseClient, igId: string): Promise<SessaoDaConta | null> {
  const { data, error } = await db
    .from("channel_sessions")
    .select("id, organization_id")
    .eq("provider", PROVIDER)
    .eq("social_account_id", igId)
    .is("archived_at", null)
    .maybeSingle();
  if (error) throw new Error(`Não foi possível consultar a conta conectada: ${error.code ?? error.message}`);
  return data ? { id: data.id as string, organizationId: data.organization_id as string } : null;
}

export interface NovaSessao {
  organizationId: string;
  userId: string;
  socialAccountId: string;
  username: string;
  tokenCifrado: string;
  tokenExpiraEm: Date | null;
  webhookAssinado: boolean;
}

/** Cria o canal. A IA nasce pausada (`pre_go_live`) e o limite de números do plano sobe cru para a rota dizer o número. */
export async function criarSessao(db: SupabaseClient, nova: NovaSessao): Promise<{ id: string }> {
  // O canal não usa o webhook por token de sessão (o da Meta é um só por app), mas
  // a coluna do segredo é obrigatória e o token de caminho único evita sessão órfã.
  const segredo = await encryptWebhookSecret(db, randomBytes(32).toString("hex"));
  if (!segredo) throw new Error("cifra_indisponivel");
  const { data, error } = await db
    .from("channel_sessions")
    .insert({
      organization_id: nova.organizationId,
      provider: PROVIDER,
      social_account_id: nova.socialAccountId,
      meta_social_token_encrypted: nova.tokenCifrado,
      meta_social_token_expires_at: nova.tokenExpiraEm?.toISOString() ?? null,
      webhook_secret_encrypted: segredo,
      webhook_path_token: randomBytes(24).toString("hex"),
      display_name: `instagram · ${nova.username || nova.socialAccountId}`,
      status: "WORKING",
      created_by: nova.userId,
      metadata: {
        ...metadataInicialDoCanal(),
        social_platform: "instagram",
        meta_social_webhook_assinado: nova.webhookAssinado,
      },
    })
    .select("id")
    .single();
  if (lerLimiteEstourado(error)) throw error;
  if (error || !data) throw new Error(`Não foi possível criar o canal: ${error?.code ?? "sem retorno"}`);
  return { id: data.id as string };
}

/** Renova token e estado da assinatura de uma sessão que a organização já tinha. */
export async function atualizarSessao(
  db: SupabaseClient,
  input: {
    organizationId: string;
    sessionId: string;
    tokenCifrado: string;
    tokenExpiraEm: Date | null;
    webhookAssinado: boolean;
  },
): Promise<void> {
  const { error } = await db
    .from("channel_sessions")
    .update({
      meta_social_token_encrypted: input.tokenCifrado,
      meta_social_token_expires_at: input.tokenExpiraEm?.toISOString() ?? null,
      status: "WORKING",
    })
    .eq("organization_id", input.organizationId)
    .eq("id", input.sessionId);
  if (error) throw new Error(`Não foi possível renovar o canal: ${error.code ?? error.message}`);
  // O sinal de assinatura mora no metadata (jsonb): mescla pela função do banco seria
  // exagero para um booleano de diagnóstico — lê, mescla e grava na mesma organização.
  const { data } = await db
    .from("channel_sessions")
    .select("metadata")
    .eq("organization_id", input.organizationId)
    .eq("id", input.sessionId)
    .maybeSingle();
  const metadata = { ...((data?.metadata as Record<string, unknown> | null) ?? {}), meta_social_webhook_assinado: input.webhookAssinado };
  await db
    .from("channel_sessions")
    .update({ metadata })
    .eq("organization_id", input.organizationId)
    .eq("id", input.sessionId);
}
