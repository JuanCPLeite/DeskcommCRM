import { assertDestinoResolvidoSeguro } from "@/lib/automation/outbound-ip";
import { assertSafeOutboundUrl } from "@/lib/automation/outbound-url";
import { MAX_MEDIA_BYTES, MediaTooLargeError } from "@/lib/messaging/media/types";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";

import { FalhaDeEnvioDoCanal, naturezaDoStatusHttp, type NaturezaDaFalha } from "../falha-de-envio";
import { graphBaseUrl } from "../meta/graph-base";
import { socialMessageId } from "../social/catalog";
import type { ChannelAdapter } from "../types";

/**
 * Adaptador da conexão DIRETA com a Meta (Instagram). É TRADUTOR de formato: o
 * que decide aqui é o corpo do pedido à Graph API e a NATUREZA da falha
 * (`../falha-de-envio.ts`) — permanente (não re-tenta o turno inteiro) ou
 * transitória. O token do login mora cifrado em `channel_sessions` e NUNCA entra
 * em mensagem de erro, log nem URL (vai em `Authorization`).
 *
 * O destinatário é o `providerConversationId` da conversa (o id do participante,
 * que a ingestão grava): sem ele o cliente ainda não escreveu, e a janela de
 * conversa só abre quando ele escreve.
 */

const TIPOS_ENVIADOS = ["text", "image", "video", "audio"] as const;
const TIMEOUT_MS = 15_000;
/** Códigos da Meta que pedem para ir mais devagar: a mesma mensagem sai daqui a pouco. */
const CODIGOS_DE_LIMITE = new Set([4, 17, 32, 613]);
/** Token inválido, expirado ou revogado. */
const CODIGOS_DE_TOKEN = new Set([102, 190]);

interface SessaoDoToken {
  token: string;
  expiraEm: Date | null;
}

/** O token da sessão ativa da conta, decifrado — ou `null` (sessão desconectada). */
async function sessaoDoToken(organizationId: string, contaId: string): Promise<SessaoDoToken | null> {
  const db = createAdminClient();
  const { data } = await db
    .from("channel_sessions")
    .select("meta_social_token_encrypted, meta_social_token_expires_at")
    .eq("organization_id", organizationId)
    .eq("provider", "meta_social")
    .eq("social_account_id", contaId)
    .is("archived_at", null)
    .maybeSingle();
  const cifrado = data?.meta_social_token_encrypted as string | null | undefined;
  if (!cifrado) return null;
  const token = await decryptWebhookSecret(db, cifrado);
  if (!token) return null;
  const expira = data?.meta_social_token_expires_at as string | null | undefined;
  return { token, expiraEm: expira ? new Date(expira) : null };
}

interface ErroDaGraph {
  error?: { message?: string; code?: number; error_subcode?: number };
}

/** Traduz a recusa da Meta para uma falha classificada, com frase de quem opera e SEM o texto cru (que pode ecoar dados). */
function falhaDaMeta(status: number, corpo: ErroDaGraph): FalhaDeEnvioDoCanal {
  const codigo = corpo.error?.code;
  const subcodigo = corpo.error?.error_subcode;
  if (codigo !== undefined && CODIGOS_DE_TOKEN.has(codigo)) {
    return new FalhaDeEnvioDoCanal("O acesso desta conta venceu. Reconecte em Conexões › Instagram.", "permanente", status);
  }
  if (codigo === 10 || subcodigo === 2534022) {
    return new FalhaDeEnvioDoCanal(
      "A janela de 24 horas desta conversa venceu. Só dá para responder depois que a pessoa escrever de novo.",
      "permanente",
      status,
    );
  }
  if (codigo === 551) {
    return new FalhaDeEnvioDoCanal("Esta pessoa não pode receber a mensagem agora.", "permanente", status);
  }
  const natureza: NaturezaDaFalha =
    (codigo !== undefined && CODIGOS_DE_LIMITE.has(codigo)) ? "transitoria" : naturezaDoStatusHttp(status);
  return new FalhaDeEnvioDoCanal(
    natureza === "transitoria"
      ? "A Meta pediu para tentar de novo em instantes."
      : "A Meta recusou o envio desta mensagem.",
    natureza,
    status,
  );
}

function mensagemDoEnvelope(envelope: Parameters<ChannelAdapter["send"]>[0]): Record<string, unknown> {
  if (envelope.media) {
    // A DM do Instagram não leva legenda junto do anexo: o anexo sai sozinho.
    return { attachment: { type: envelope.kind, payload: { url: envelope.media.url } } };
  }
  return { text: envelope.body ?? "" };
}

export const metaSocialAdapter: ChannelAdapter = {
  provider: "meta_social",
  // O endereço é a thread da própria conversa, nunca um telefone.
  resolveRecipient: (input) => (input.isGroup ? null : "provider-thread"),
  // A credencial é por sessão: quem não tem token falha no envio, dizendo o que fazer.
  isConfigured: () => true,
  async send(envelope) {
    if (!envelope.providerConversationId) {
      throw new FalhaDeEnvioDoCanal("Aguarde uma mensagem do cliente para responder nesta rede.", "permanente");
    }
    if (!(TIPOS_ENVIADOS as readonly string[]).includes(envelope.kind)) {
      throw new FalhaDeEnvioDoCanal("Este tipo de mensagem ainda não é suportado nesta rede.", "permanente");
    }
    const sessao = await sessaoDoToken(envelope.organizationId, envelope.sessionRef);
    if (!sessao) throw new FalhaDeEnvioDoCanal("Reconecte esta conta em Conexões › Instagram.", "permanente");

    await envelope.beforeSend?.();

    let resposta: Response;
    try {
      resposta = await fetch(`${graphBaseUrl()}/${encodeURIComponent(envelope.sessionRef)}/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${sessao.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ recipient: { id: envelope.providerConversationId }, message: mensagemDoEnvelope(envelope) }),
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      // Rede caindo ou tempo esgotado: a mensagem PODE não ter saído, e tentar de novo é o certo.
      throw new FalhaDeEnvioDoCanal("Não deu para falar com a Meta agora.", "transitoria");
    }
    const corpo = (await resposta.json().catch(() => ({}))) as ErroDaGraph & { message_id?: string };
    if (!resposta.ok) throw falhaDaMeta(resposta.status, corpo);
    // A Meta respondeu sem o id: a mensagem PODE ter saído. Re-tentar arriscaria mandá-la
    // duas vezes — e mandar duas vezes é pior que não mandar.
    if (!corpo.message_id) {
      throw new FalhaDeEnvioDoCanal(
        "Envio sem confirmação da Meta. Confira a conversa antes de tentar novamente.",
        "permanente",
      );
    }
    return { externalId: socialMessageId(envelope.sessionRef, corpo.message_id) };
  },
  async checkHealth(input) {
    const sessao = await sessaoDoToken(input.organizationId, input.sessionRef);
    if (!sessao) return { reachable: true, status: "FAILED", detail: "credencial_indisponivel" };
    if (sessao.expiraEm && sessao.expiraEm.getTime() <= Date.now()) {
      return { reachable: true, status: "FAILED", detail: "token_vencido" };
    }
    try {
      const resposta = await fetch(`${graphBaseUrl()}/${encodeURIComponent(input.sessionRef)}?fields=id`, {
        headers: { Authorization: `Bearer ${sessao.token}` },
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (resposta.ok) return { reachable: true, status: "WORKING", detail: null };
      const corpo = (await resposta.json().catch(() => ({}))) as ErroDaGraph;
      const codigo = corpo.error?.code;
      if (codigo !== undefined && CODIGOS_DE_TOKEN.has(codigo)) {
        return { reachable: true, status: "FAILED", detail: "token_invalido" };
      }
      return { reachable: resposta.status < 500, status: resposta.status < 500 ? "FAILED" : null, detail: "conta_requer_atencao" };
    } catch {
      return { reachable: false, status: null, detail: "meta_indisponivel" };
    }
  },
  /**
   * A mídia que o cliente mandou é um endereço assinado da CDN da Meta: baixa SEM
   * token (a assinatura está na URL), só por https, só para fora da rede interna,
   * sem seguir redirecionamento e com teto de tamanho.
   */
  async fetchInboundMedia(input) {
    const url = new URL(input.url);
    if (url.protocol !== "https:") throw new Error("Endereço de mídia recusado.");
    assertSafeOutboundUrl(url.toString());
    await assertDestinoResolvidoSeguro(url.hostname);
    const resposta = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!resposta.ok) throw new Error(`Falha ao baixar mídia (HTTP ${resposta.status}).`);
    if (Number(resposta.headers.get("content-length") ?? 0) > MAX_MEDIA_BYTES) {
      await resposta.body?.cancel();
      throw new MediaTooLargeError();
    }
    const leitor = resposta.body?.getReader();
    if (!leitor) throw new Error("A mídia retornou um corpo vazio.");
    const pedacos: Uint8Array[] = [];
    let tamanho = 0;
    try {
      while (true) {
        const { done, value } = await leitor.read();
        if (done) break;
        tamanho += value.byteLength;
        if (tamanho > MAX_MEDIA_BYTES) {
          await leitor.cancel();
          throw new MediaTooLargeError();
        }
        pedacos.push(value);
      }
    } finally {
      leitor.releaseLock();
    }
    return {
      buffer: Buffer.concat(pedacos),
      mime: resposta.headers.get("content-type")?.split(";")[0] ?? input.hintMime ?? "application/octet-stream",
    };
  },
  codes: {
    notConfigured: "meta_social_not_configured",
    sendFailed: "meta_social_error",
    unknownError: "meta_social_unknown",
    throttled: "meta_social_throttled",
  },
};
