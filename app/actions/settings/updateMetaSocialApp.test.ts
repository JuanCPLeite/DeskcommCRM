import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A ação que grava o app Meta SOCIAL da instalação. O que ela promete:
 *  - segredo e token NUNCA em claro: se a cifra não existe, recusa e não grava;
 *  - o verify token é gerado pelo servidor na primeira vez e devolvido UMA vez;
 *  - dá para trocar só os identificadores sem redigitar a chave (que a tela não mostra);
 *  - a auditoria registra O QUE mudou, jamais o valor.
 */

const upsert = vi.fn(async () => ({ error: null as null | { code: string } }));
let linhaGravada: { app_secret_encrypted: string | null; verify_token_encrypted: string | null } | null = null;
let erroDeLeitura: { code: string } | null = null;
let cifraDisponivel = true;
const audit = vi.fn(async () => undefined);
const invalidar = vi.fn();

vi.mock("@/lib/auth/escritaDeAdminOuRecusa", () => ({
  escritaDeAdminOuRecusa: async () => ({ ok: true, ctx: { user: { id: "user-admin" } } }),
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-request-id": "req-1" }) }));
vi.mock("@/lib/audit", () => ({ audit: (...a: unknown[]) => audit(...(a as [])) }));
vi.mock("@/lib/channels/meta-social/app", () => ({ invalidarAppSocialDaMeta: () => invalidar() }));
vi.mock("@/lib/http/ip-do-cliente", () => ({ ipDoCliente: () => "203.0.113.9" }));
vi.mock("@/lib/webhooks/secrets", () => ({
  encryptWebhookSecret: async (_a: unknown, claro: string) => (cifraDisponivel ? `CIFRADO(${claro.length})` : null),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: linhaGravada, error: erroDeLeitura }) }) }),
      upsert: (...a: unknown[]) => upsert(...(a as [])),
    }),
  }),
}));

import { rotacionarVerifyTokenDoAppSocial, updateMetaSocialApp } from "./updateMetaSocialApp";

const SEGREDO = "0123456789abcdef0123456789abcdef";

beforeEach(() => {
  upsert.mockClear();
  audit.mockClear();
  invalidar.mockClear();
  linhaGravada = null;
  erroDeLeitura = null;
  cifraDisponivel = true;
});

describe("updateMetaSocialApp", () => {
  it("primeiro save com chave: grava cifrado, gera o token e o devolve uma vez", async () => {
    const r = await updateMetaSocialApp({ appId: "1686546369790015", loginConfigId: "1150495034023360", appSecret: SEGREDO });
    expect(r.ok).toBe(true);
    expect(r.ok && typeof r.verifyToken === "string" && r.verifyToken.length >= 32).toBe(true);
    const gravado = (upsert.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(gravado.app_id).toBe("1686546369790015");
    expect(gravado.app_secret_encrypted).toBe(`CIFRADO(${SEGREDO.length})`);
    expect(String(gravado.verify_token_encrypted)).toMatch(/^CIFRADO\(/);
    expect(JSON.stringify(gravado)).not.toContain(SEGREDO);
    expect(invalidar).toHaveBeenCalledTimes(1);
  });

  it("a auditoria diz o que mudou e nunca o valor", async () => {
    const r = await updateMetaSocialApp({ appId: "1686546369790015", appSecret: SEGREDO });
    expect(r.ok).toBe(true);
    const chamada = JSON.stringify(audit.mock.calls);
    expect(chamada).toContain("platform_meta_social_app");
    expect(chamada).not.toContain(SEGREDO);
    if (r.ok && r.verifyToken) expect(chamada).not.toContain(r.verifyToken);
  });

  it("sem cifra na instalação: recusa e não grava nada", async () => {
    cifraDisponivel = false;
    const r = await updateMetaSocialApp({ appSecret: SEGREDO });
    expect(r.ok).toBe(false);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("já configurado: troca só os identificadores sem tocar nos segredos nem gerar token novo", async () => {
    linhaGravada = { app_secret_encrypted: "\\xA", verify_token_encrypted: "\\xB" };
    const r = await updateMetaSocialApp({ appId: "999", loginConfigId: "111" });
    expect(r.ok).toBe(true);
    expect(r.ok && r.verifyToken).toBeFalsy();
    const gravado = (upsert.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(gravado).not.toHaveProperty("app_secret_encrypted");
    expect(gravado).not.toHaveProperty("verify_token_encrypted");
    expect(gravado.app_id).toBe("999");
  });

  it("leitura do que está gravado falhou: não grava (não vira 'primeira vez' e não troca o token colado na Meta)", async () => {
    erroDeLeitura = { code: "XX000" };
    const r = await updateMetaSocialApp({ appSecret: SEGREDO });
    expect(r).toMatchObject({ ok: false, error: "leitura_do_app_falhou" });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("recusa chave curta demais", async () => {
    const r = await updateMetaSocialApp({ appSecret: "curta" });
    expect(r).toMatchObject({ ok: false, error: "invalid_input" });
    expect(upsert).not.toHaveBeenCalled();
  });
});

describe("rotacionarVerifyTokenDoAppSocial", () => {
  it("sem chave gravada não gera token (ele nunca valeria)", async () => {
    const r = await rotacionarVerifyTokenDoAppSocial();
    expect(r).toMatchObject({ ok: false, error: "app_secret_obrigatorio" });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("com chave gravada gera o token novo e o devolve uma vez", async () => {
    linhaGravada = { app_secret_encrypted: "\\xA", verify_token_encrypted: "\\xB" };
    const r = await rotacionarVerifyTokenDoAppSocial();
    expect(r.ok && typeof r.verifyToken === "string").toBe(true);
    const gravado = (upsert.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(String(gravado.verify_token_encrypted)).toMatch(/^CIFRADO\(/);
    expect(invalidar).toHaveBeenCalledTimes(1);
  });
});
