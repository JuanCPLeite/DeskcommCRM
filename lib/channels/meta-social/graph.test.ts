import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assinarWebhooks,
  contasAtribuidas,
  desassinarWebhooks,
  expiracaoDoToken,
  perfilDaConta,
  SemContaAtribuidaError,
} from "@/lib/channels/meta-social/graph";

function resposta(corpo: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(corpo), { status }));
}

afterEach(() => vi.unstubAllGlobals());

describe("graph do canal Meta social", () => {
  it("lista as contas atribuídas ao login; o token vai no cabeçalho, não na URL", async () => {
    const f = resposta({ data: [{ id: "1784", username: "loja" }] });
    vi.stubGlobal("fetch", f);
    expect(await contasAtribuidas("TOKEN-SECRETO")).toEqual([{ id: "1784", username: "loja" }]);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toMatch(/\/me\/assigned_instagram_accounts\?fields=id%2Cusername$/);
    expect(String(url)).not.toContain("TOKEN-SECRETO");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer TOKEN-SECRETO");
  });

  it("nenhuma conta atribuída vira erro próprio, para a tela explicar o que fazer", async () => {
    vi.stubGlobal("fetch", resposta({ data: [] }));
    await expect(contasAtribuidas("t")).rejects.toBeInstanceOf(SemContaAtribuidaError);
  });

  it("lê o perfil da conta pelo id", async () => {
    const f = resposta({ id: "1784", username: "loja", name: "Loja", profile_picture_url: "https://x/y.jpg" });
    vi.stubGlobal("fetch", f);
    expect(await perfilDaConta("t", "1784")).toMatchObject({ id: "1784", username: "loja" });
    expect(String((f.mock.calls[0] as unknown as [string])[0])).toMatch(/\/1784\?fields=/);
  });

  it("assina o webhook da conta nos campos que o canal usa e devolve se deu certo", async () => {
    const f = resposta({ success: true });
    vi.stubGlobal("fetch", f);
    expect(await assinarWebhooks("t", "1784")).toBe(true);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toMatch(/\/1784\/subscribed_apps$/);
    expect(init.method).toBe("POST");
    const corpo = String(init.body);
    for (const campo of ["messages", "messaging_postbacks", "comments", "live_comments"]) {
      expect(corpo).toContain(campo);
    }
  });

  it("falha de assinatura devolve false em vez de derrubar a conexão (fica visível na tela)", async () => {
    vi.stubGlobal("fetch", resposta({ error: { message: "x" } }, 400));
    expect(await assinarWebhooks("t", "1784")).toBe(false);
  });

  it("desassina o webhook da conta (DELETE) e devolve se deu certo", async () => {
    const f = resposta({ success: true });
    vi.stubGlobal("fetch", f);
    expect(await desassinarWebhooks("TOKEN-SECRETO", "1784")).toBe(true);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toMatch(/\/1784\/subscribed_apps$/);
    expect(init.method).toBe("DELETE");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer TOKEN-SECRETO");
    vi.stubGlobal("fetch", resposta({ error: {} }, 400));
    expect(await desassinarWebhooks("t", "1784")).toBe(false);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("rede"); }));
    expect(await desassinarWebhooks("t", "1784")).toBe(false);
  });

  it("expiração: 0 da Meta significa que não expira; senão, a data", async () => {
    vi.stubGlobal("fetch", resposta({ data: { expires_at: 0 } }));
    expect(await expiracaoDoToken({ token: "t", appId: "1", appSecret: "s".repeat(32) })).toBeNull();
    vi.stubGlobal("fetch", resposta({ data: { expires_at: 1_800_000_000 } }));
    expect((await expiracaoDoToken({ token: "t", appId: "1", appSecret: "s".repeat(32) }))?.toISOString()).toBe(
      new Date(1_800_000_000 * 1000).toISOString(),
    );
  });

  it("expiração desconhecida (falha na consulta) é null, nunca derruba a conexão", async () => {
    vi.stubGlobal("fetch", resposta({ error: {} }, 500));
    expect(await expiracaoDoToken({ token: "t", appId: "1", appSecret: "s".repeat(32) })).toBeNull();
  });
});
