import { describe, expect, it } from "vitest";
import { getAdapter } from "@/lib/channels";
import { FalhaDeEnvioDoCanal } from "@/lib/channels/falha-de-envio";
import {
  capabilitiesOf,
  PROVIDERS_DE_MENSAGEM,
  PROVIDERS_DE_TELEFONE,
  transportaMensagem,
} from "@/lib/channels/capabilities";
import { channelBrand } from "@/lib/channels/presentation";
import { resolveSessionRef } from "@/lib/channels/session-ref";

/**
 * O provider da conexão DIRETA com a Meta (Instagram/Facebook), ao lado do
 * `zernio_social`. Este arquivo prova só o que a MATRIZ de canais decide; o
 * transporte (webhook, envio) tem os testes dele em `lib/channels/meta-social`.
 */
describe("provider meta_social na matriz de canais", () => {
  it("é um canal de mensagem", () => {
    expect(transportaMensagem("meta_social")).toBe(true);
    expect(PROVIDERS_DE_MENSAGEM as readonly string[]).toContain("meta_social");
  });

  it("não alcança telefone: o endereço é o handle da rede, como no social intermediado", () => {
    expect(PROVIDERS_DE_TELEFONE as readonly string[]).not.toContain("meta_social");
  });

  it("tem as mesmas restrições do Instagram intermediado: só fala dentro da janela e sem modelo", () => {
    const direto = capabilitiesOf("meta_social");
    const intermediado = capabilitiesOf("zernio_social");
    expect(direto.freeformOutsideWindow).toBe(false);
    expect(direto.requiresTemplates).toBe(false);
    expect(direto.banRisk).toBe(false);
    expect(direto.voiceNote).toBe("none");
    expect(direto).toEqual(intermediado);
  });

  it("endereça a sessão pelo id da conta Meta, não pelo id do provedor intermediário", () => {
    expect(resolveSessionRef({ provider: "meta_social", social_account_id: "17841400000000000" })).toBe(
      "17841400000000000",
    );
  });

  it("a marca de tela vem da rede, e Instagram continua sendo Instagram", () => {
    expect(channelBrand({ provider: "meta_social", social_platform: "instagram" })).toBe("instagram");
    expect(channelBrand({ provider: "meta_social", social_platform: "facebook" })).toBe("messenger");
    expect(channelBrand({ provider: "meta_social", social_platform: null })).toBe("unknown");
  });

  it("sem transporte ainda: o adaptador existe, não finge envio e recusa de forma permanente", async () => {
    const adapter = getAdapter("meta_social");
    expect(adapter.provider).toBe("meta_social");
    expect(adapter.isConfigured()).toBe(false);
    expect(adapter.resolveRecipient({ isGroup: false } as never)).toBe("provider-thread");
    expect(adapter.reportConversion).toBeUndefined();
    const envio = adapter.send({
      organizationId: "org",
      sessionRef: "17841400000000000",
      to: "provider-thread",
      kind: "text",
      text: "oi",
    } as never);
    await expect(envio).rejects.toBeInstanceOf(FalhaDeEnvioDoCanal);
    await expect(envio).rejects.toMatchObject({ natureza: "permanente" });
  });
});
