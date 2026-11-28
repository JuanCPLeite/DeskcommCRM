import { FalhaDeEnvioDoCanal } from "../falha-de-envio";
import type { ChannelAdapter } from "../types";

/**
 * Adaptador da conexão DIRETA com a Meta (Instagram/Facebook).
 *
 * Nesta fatia ele só existe para a matriz de canais ficar exaustiva: sem
 * transporte, ele NÃO finge envio — recusa de forma permanente, que é o que
 * impede a fila de re-tentar o turno inteiro (ver `../falha-de-envio.ts`). O
 * envio real chega na Task 7 do plano da Fase 1.
 */
export const metaSocialAdapter: ChannelAdapter = {
  provider: "meta_social",
  // O endereço é a thread da própria conversa, nunca um telefone.
  resolveRecipient: (input) => (input.isGroup ? null : "provider-thread"),
  isConfigured: () => false,
  async send() {
    throw new FalhaDeEnvioDoCanal(
      "O canal do Instagram pela Meta ainda não tem envio configurado.",
      "permanente",
    );
  },
  codes: {
    notConfigured: "meta_social_not_configured",
    sendFailed: "meta_social_error",
    unknownError: "meta_social_unknown",
  },
};
