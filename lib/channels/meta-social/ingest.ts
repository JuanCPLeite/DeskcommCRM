/**
 * A entrada das DMs do Instagram pela conexão DIRETA com a Meta.
 *
 * Não reimplementa a ingestão: o contato de rede social, a conversa, a mensagem
 * (com a idempotência `unique (organization_id, external_id)`), o opt-out, a pausa
 * da IA por atendimento manual e o despacho do agente são do `ingestZernioInbound`,
 * que já aceita uma `socialMessage` pronta. Este módulo faz duas coisas:
 *
 *  1. acha a organização pela CONTA que recebeu (`channel_sessions.social_account_id`,
 *     única entre organizações) — nunca por nada que o corpo diga sobre tenant;
 *  2. monta a `socialMessage` no formato que o núcleo espera.
 *
 * A THREAD da conversa é o próprio participante: é o id que a Graph API endereça
 * no envio (`recipient.id`), e o adaptador lê `provider_conversation_id` para isso.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { socialMessageId } from "../social/catalog";
import type { SocialMessage } from "../social/parser";
import { ingestZernioInbound, type ZernioIngestResult } from "../zernio/ingest";
import type { MetaSocialEvento } from "./webhook";

const PROVIDER = "meta_social";
const PLATAFORMA = "instagram";

/** A sessão ATIVA da conta, ou `null` se ninguém a conectou. Erro de banco SOBE: a Meta reentrega. */
export async function sessaoDaConta(
  db: SupabaseClient,
  contaId: string,
): Promise<{ id: string; organizationId: string } | null> {
  const { data, error } = await db
    .from("channel_sessions")
    .select("id, organization_id")
    .eq("provider", PROVIDER)
    .eq("social_account_id", contaId)
    .is("archived_at", null)
    .maybeSingle();
  if (error) throw new Error(`sessao_meta_social_falhou:${error.code ?? "sem_codigo"}`);
  return data ? { id: data.id as string, organizationId: data.organization_id as string } : null;
}

function paraSocialMessage(e: MetaSocialEvento): SocialMessage {
  const saida = e.tipo === "eco";
  return {
    platform: PLATAFORMA,
    participantId: e.participanteId,
    accountId: e.contaId,
    conversationId: e.participanteId,
    externalId: socialMessageId(e.contaId, e.mid),
    // O ECO é a DM que o CRM (ou uma pessoa, pelo app) enviou: entra como SAÍDA. Nunca
    // como recebida — isso acionaria a IA contra a própria resposta.
    direction: saida ? "outbound" : "inbound",
    kind: "message",
    ...(saida ? { status: "sent" as const } : {}),
    text: e.texto,
    sentAt: e.enviadoEm.toISOString(),
    attachments: e.anexos.map((a) => ({ type: a.tipo, url: a.url })),
    referral: null,
    identity: { phone: null, bsuid: null, anchor: null, username: null, displayName: null },
  };
}

export async function ingestMetaSocial(
  db: SupabaseClient,
  evento: MetaSocialEvento,
  /** Quando a rota já resolveu a sessão (para arquivar o corpo cru), evita uma segunda ida ao banco. */
  sessaoJaResolvida?: { id: string; organizationId: string },
): Promise<ZernioIngestResult> {
  // Comentário e demais campos chegam (o webhook já os assina), mas só têm
  // tratamento na Fase 2: ignorar aqui é 200 para a Meta, sem reentrega.
  if (evento.tipo === "comentario" || evento.tipo === "outro") {
    return { status: "ignored", reason: "tipo_sem_tratamento" };
  }
  if (!evento.participanteId || !evento.mid) return { status: "ignored", reason: "evento_incompleto" };

  const sessao = sessaoJaResolvida ?? (await sessaoDaConta(db, evento.contaId));
  if (!sessao) return { status: "ignored", reason: "conta_desconhecida" };

  return ingestZernioInbound(db, {
    organizationId: sessao.organizationId,
    channelSessionId: sessao.id,
    payload: null,
    socialMessage: paraSocialMessage(evento),
  });
}
