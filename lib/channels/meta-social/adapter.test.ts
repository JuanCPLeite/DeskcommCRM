import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O envio de DM do Instagram pela conexão direta. O adaptador é TRADUTOR de
 * formato (doutrina de canais): o que decide aqui é o corpo do pedido à Graph API
 * e a natureza da falha — permanente (não re-tenta o turno inteiro) ou
 * transitória. O token mora cifrado na sessão e NUNCA aparece em erro nem log.
 */

let tokenCifrado: string | null = "\\xTOKEN";
let expiraEm: string | null = null;
let tokenClaro: string | null = "TOKEN-SECRETO-DO-LOGIN";
const beforeSend = vi.fn(async () => undefined);

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    const q: Record<string, unknown> = {
      select: () => q,
      eq: () => q,
      is: () => q,
      maybeSingle: async () => ({
        data: tokenCifrado === null ? null : { social_token_encrypted: tokenCifrado, social_token_expires_at: expiraEm },
        error: null,
      }),
    };
    return { from: () => q };
  },
}));
vi.mock("@/lib/webhooks/secrets", () => ({ decryptWebhookSecret: async () => tokenClaro }));

import { FalhaDeEnvioDoCanal } from "@/lib/channels/falha-de-envio";
import { metaSocialAdapter } from "@/lib/channels/meta-social/adapter";

const CONTA = "17841400000000001";
const PESSOA = "9988776655";

function envelope(extra: Record<string, unknown> = {}) {
  return {
    organizationId: "org-A",
    sessionRef: CONTA,
    to: "provider-thread",
    kind: "text",
    body: "olá!",
    providerConversationId: PESSOA,
    beforeSend,
    ...extra,
  } as never;
}

function responder(corpo: unknown, status = 200) {
  const f = vi.fn(async () => new Response(JSON.stringify(corpo), { status }));
  vi.stubGlobal("fetch", f);
  return f;
}

async function falha(promessa: Promise<unknown>): Promise<FalhaDeEnvioDoCanal> {
  try {
    await promessa;
  } catch (e) {
    return e as FalhaDeEnvioDoCanal;
  }
  throw new Error("devia ter falhado");
}

beforeEach(() => {
  vi.clearAllMocks();
  tokenCifrado = "\\xTOKEN";
  expiraEm = null;
  tokenClaro = "TOKEN-SECRETO-DO-LOGIN";
});
afterEach(() => vi.unstubAllGlobals());

describe("send", () => {
  it("texto: POST /{conta}/messages com o destinatário e o texto; o token vai no cabeçalho", async () => {
    const f = responder({ recipient_id: PESSOA, message_id: "mid-saida" });
    const r = await metaSocialAdapter.send(envelope());
    expect(r).toEqual({ externalId: `social:${CONTA}:mid-saida` });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toMatch(new RegExp(`/${CONTA}/messages$`));
    expect(String(url)).not.toContain("TOKEN-SECRETO");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer TOKEN-SECRETO-DO-LOGIN");
    expect(JSON.parse(String(init.body))).toEqual({ recipient: { id: PESSOA }, message: { text: "olá!" } });
    expect(beforeSend).toHaveBeenCalledTimes(1);
  });

  it("imagem: manda o anexo pela URL", async () => {
    const f = responder({ recipient_id: PESSOA, message_id: "mid-img" });
    await metaSocialAdapter.send(envelope({ kind: "image", body: undefined, media: { url: "https://cdn.exemplo/a.jpg" } }));
    const corpo = JSON.parse(String(((f.mock.calls[0] as unknown) as [string, RequestInit])[1].body));
    expect(corpo.message).toEqual({ attachment: { type: "image", payload: { url: "https://cdn.exemplo/a.jpg" } } });
  });

  it("sem a thread do cliente (ele ainda não escreveu): recusa permanente, sem chamar a Meta", async () => {
    const f = responder({});
    const e = await falha(metaSocialAdapter.send(envelope({ providerConversationId: null })));
    expect(e).toBeInstanceOf(FalhaDeEnvioDoCanal);
    expect(e.natureza).toBe("permanente");
    expect(f).not.toHaveBeenCalled();
  });

  it("tipo que o canal não envia: permanente", async () => {
    responder({});
    const e = await falha(metaSocialAdapter.send(envelope({ kind: "document" })));
    expect(e.natureza).toBe("permanente");
  });

  it("sessão sem token (desconectada): pede para reconectar, permanente", async () => {
    tokenCifrado = null;
    responder({});
    const e = await falha(metaSocialAdapter.send(envelope()));
    expect(e.natureza).toBe("permanente");
    expect(e.message).toMatch(/Reconecte/);
  });

  it("resposta sem message_id: permanente (a mensagem PODE ter saído; re-tentar mandaria duas vezes)", async () => {
    responder({ recipient_id: PESSOA });
    const e = await falha(metaSocialAdapter.send(envelope()));
    expect(e.natureza).toBe("permanente");
    expect(e.message).toMatch(/Confira a conversa/);
  });

  it("token inválido/expirado (código 190): permanente, e o token nunca aparece no erro", async () => {
    responder({ error: { message: "Invalid OAuth access token.", code: 190 } }, 400);
    const e = await falha(metaSocialAdapter.send(envelope()));
    expect(e.natureza).toBe("permanente");
    expect(e.message).not.toContain("TOKEN-SECRETO");
    expect(e.message).toMatch(/Reconecte/);
  });

  it("fora da janela de 24 horas: permanente, com a frase certa", async () => {
    responder({ error: { message: "This message is sent outside of allowed window.", code: 10, error_subcode: 2534022 } }, 400);
    const e = await falha(metaSocialAdapter.send(envelope()));
    expect(e.natureza).toBe("permanente");
    expect(e.message).toMatch(/24 horas/);
  });

  it("limite de velocidade (429 ou código 4/17/32/613): transitória", async () => {
    responder({ error: { message: "rate", code: 4 } }, 400);
    expect((await falha(metaSocialAdapter.send(envelope()))).natureza).toBe("transitoria");
    responder({ error: { message: "slow down" } }, 429);
    expect((await falha(metaSocialAdapter.send(envelope()))).natureza).toBe("transitoria");
  });

  it("5xx da Meta: transitória", async () => {
    responder({ error: { message: "oops" } }, 503);
    expect((await falha(metaSocialAdapter.send(envelope()))).natureza).toBe("transitoria");
  });
});

describe("checkHealth", () => {
  const entrada = { organizationId: "org-A", sessionRef: CONTA } as never;

  it("token vencido pela data gravada: FAILED sem nem chamar a Meta", async () => {
    expiraEm = new Date(Date.now() - 1000).toISOString();
    const f = responder({ id: CONTA });
    expect(await metaSocialAdapter.checkHealth!(entrada)).toMatchObject({ reachable: true, status: "FAILED", detail: "token_vencido" });
    expect(f).not.toHaveBeenCalled();
  });

  it("token bom e Meta respondendo: WORKING", async () => {
    responder({ id: CONTA });
    expect(await metaSocialAdapter.checkHealth!(entrada)).toMatchObject({ reachable: true, status: "WORKING" });
  });

  it("Meta recusa o token (190): FAILED token_invalido; Meta fora do ar: não alcançável", async () => {
    responder({ error: { code: 190, message: "x" } }, 400);
    expect(await metaSocialAdapter.checkHealth!(entrada)).toMatchObject({ reachable: true, status: "FAILED", detail: "token_invalido" });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("rede"); }));
    expect(await metaSocialAdapter.checkHealth!(entrada)).toMatchObject({ reachable: false });
  });

  it("sessão sem token: FAILED credencial_indisponivel", async () => {
    tokenCifrado = null;
    expect(await metaSocialAdapter.checkHealth!(entrada)).toMatchObject({ reachable: true, status: "FAILED", detail: "credencial_indisponivel" });
  });
});
