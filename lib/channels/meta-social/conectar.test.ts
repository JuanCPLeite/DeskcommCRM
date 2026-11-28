import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O fluxo de conectar contas Instagram pelo login unificado, com o transporte e o
 * banco substituídos por dublês — o que se mede é a DECISÃO: quem pode concluir,
 * o que acontece quando a Meta não traz conta, e a regra de que uma conta ativa
 * pertence a UMA organização só.
 */

const app = { appId: "1686546369790015", loginConfigId: "1150495034023360", appSecret: "s".repeat(32), verifyToken: "v" };
let appVigente: typeof app | Record<string, null> = app;
const trocarCodigo = vi.fn(async () => ({ accessToken: "TOKEN-DO-LOGIN" }));
const contasAtribuidas = vi.fn(async () => [{ id: "1784", username: "loja" }]);
const perfilDaConta = vi.fn(async (_t: string, id: string) => ({ id, username: "loja", name: "Loja" }));
const assinarWebhooks = vi.fn(async () => true);
const expiracaoDoToken = vi.fn(async () => null as Date | null);
const sessaoAtivaDaConta = vi.fn(async () => null as null | { id: string; organizationId: string });
const criarSessao = vi.fn(async () => ({ id: "sessao-nova" }));
const atualizarSessao = vi.fn(async () => undefined);

vi.mock("@/lib/channels/meta-social/app", () => ({ appSocialDaMeta: async () => appVigente }));
vi.mock("@/lib/channels/meta-social/graph", async () => {
  const real = await vi.importActual<typeof import("@/lib/channels/meta-social/graph")>("@/lib/channels/meta-social/graph");
  return {
    ...real,
    contasAtribuidas: (...a: unknown[]) => contasAtribuidas(...(a as [])),
    perfilDaConta: (...a: unknown[]) => perfilDaConta(...(a as [string, string])),
    assinarWebhooks: (...a: unknown[]) => assinarWebhooks(...(a as [])),
    expiracaoDoToken: (...a: unknown[]) => expiracaoDoToken(...(a as [])),
  };
});
vi.mock("@/lib/channels/meta-social/oauth", async () => {
  const real = await vi.importActual<typeof import("@/lib/channels/meta-social/oauth")>("@/lib/channels/meta-social/oauth");
  return { ...real, trocarCodigo: (...a: unknown[]) => trocarCodigo(...(a as [])) };
});
vi.mock("@/lib/channels/meta-social/store", () => ({
  sessaoAtivaDaConta: (...a: unknown[]) => sessaoAtivaDaConta(...(a as [])),
  criarSessao: (...a: unknown[]) => criarSessao(...(a as [])),
  atualizarSessao: (...a: unknown[]) => atualizarSessao(...(a as [])),
}));
vi.mock("@/lib/webhooks/secrets", () => ({ encryptWebhookSecret: async (_d: unknown, v: string) => `CIFRADO(${v.length})` }));

import { ErroDaConexaoMeta, concluirConexaoMeta, iniciarConexaoMeta } from "@/lib/channels/meta-social/conectar";
import { paraEstadoDaMeta } from "@/lib/channels/meta-social/oauth";

const SEGREDO = "segredo-interno-com-mais-de-dezesseis";
const AGORA = new Date("2026-11-27T12:00:00Z");
const ctx = { organizationId: "org-A", userId: "user-1", segredo: SEGREDO, agora: AGORA, publicBase: "https://crm.exemplo.com" };
const db = {} as never;

function estadoValido() {
  return paraEstadoDaMeta({ organizationId: "org-A", userId: "user-1" }, { segredo: SEGREDO, agora: AGORA });
}

beforeEach(() => {
  appVigente = app;
  vi.clearAllMocks();
  contasAtribuidas.mockResolvedValue([{ id: "1784", username: "loja" }]);
  sessaoAtivaDaConta.mockResolvedValue(null);
});

describe("iniciarConexaoMeta", () => {
  it("devolve a URL do diálogo com o estado e a volta pela ponte pública", async () => {
    const { url } = await iniciarConexaoMeta(ctx);
    const u = new URL(url);
    expect(u.searchParams.get("client_id")).toBe(app.appId);
    expect(u.searchParams.get("config_id")).toBe(app.loginConfigId);
    expect(u.searchParams.get("redirect_uri")).toBe("https://crm.exemplo.com/auth/meta-social-return");
    expect(u.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]+\.[0-9a-f]{64}$/);
  });

  it("app não configurado: recusa dizendo o que falta, sem montar URL", async () => {
    appVigente = { appId: null, loginConfigId: null, appSecret: null, verifyToken: null };
    await expect(iniciarConexaoMeta(ctx)).rejects.toMatchObject({ codigo: "app_nao_configurado" });
  });
});

describe("concluirConexaoMeta", () => {
  it("caminho feliz: troca o código, cria a sessão com token cifrado e assina o webhook", async () => {
    const r = await concluirConexaoMeta(db, ctx, { estado: estadoValido(), code: "COD" });
    expect(r.conectadas).toHaveLength(1);
    expect(r.conectadas[0]).toMatchObject({ igId: "1784", username: "loja", webhookAssinado: true });
    const dados = (criarSessao.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(dados.organizationId).toBe("org-A");
    expect(dados.socialAccountId).toBe("1784");
    expect(dados.tokenCifrado).toBe(`CIFRADO(${"TOKEN-DO-LOGIN".length})`);
    expect(JSON.stringify(dados)).not.toContain("TOKEN-DO-LOGIN");
  });

  it("estado inválido, vencido ou de outra pessoa: nada é trocado nem gravado", async () => {
    for (const estado of ["lixo", paraEstadoDaMeta({ organizationId: "org-B", userId: "user-1" }, { segredo: SEGREDO, agora: AGORA }), paraEstadoDaMeta({ organizationId: "org-A", userId: "outro" }, { segredo: SEGREDO, agora: AGORA })]) {
      await expect(concluirConexaoMeta(db, ctx, { estado, code: "COD" })).rejects.toBeInstanceOf(ErroDaConexaoMeta);
    }
    expect(trocarCodigo).not.toHaveBeenCalled();
    expect(criarSessao).not.toHaveBeenCalled();
  });

  it("login sem conta atribuída vira erro próprio", async () => {
    const { SemContaAtribuidaError } = await import("@/lib/channels/meta-social/graph");
    contasAtribuidas.mockRejectedValueOnce(new SemContaAtribuidaError());
    await expect(concluirConexaoMeta(db, ctx, { estado: estadoValido(), code: "COD" })).rejects.toMatchObject({
      codigo: "sem_conta_atribuida",
    });
  });

  it("a mesma conta ativa em OUTRA organização é recusada, sem tocar na sessão alheia", async () => {
    sessaoAtivaDaConta.mockResolvedValueOnce({ id: "sessao-de-B", organizationId: "org-B" });
    const r = await concluirConexaoMeta(db, ctx, { estado: estadoValido(), code: "COD" });
    expect(r.conectadas).toHaveLength(0);
    expect(r.recusadas).toEqual([{ igId: "1784", motivo: "ja_conectada_em_outra_organizacao" }]);
    expect(criarSessao).not.toHaveBeenCalled();
    expect(atualizarSessao).not.toHaveBeenCalled();
  });

  it("reconectar a conta da MESMA organização renova o token em vez de duplicar a sessão", async () => {
    sessaoAtivaDaConta.mockResolvedValueOnce({ id: "sessao-existente", organizationId: "org-A" });
    const r = await concluirConexaoMeta(db, ctx, { estado: estadoValido(), code: "COD" });
    expect(r.conectadas).toHaveLength(1);
    expect(criarSessao).not.toHaveBeenCalled();
    expect(atualizarSessao).toHaveBeenCalledTimes(1);
  });

  it("falha ao assinar o webhook não derruba a conexão: fica registrada como não assinada", async () => {
    assinarWebhooks.mockResolvedValueOnce(false);
    const r = await concluirConexaoMeta(db, ctx, { estado: estadoValido(), code: "COD" });
    expect(r.conectadas[0]?.webhookAssinado).toBe(false);
  });

  it("falha numa conta NÃO derruba as outras: as já gravadas ficam na resposta (e serão auditadas) e a que falhou vai para recusadas", async () => {
    contasAtribuidas.mockResolvedValueOnce([{ id: "1", username: "a" }, { id: "2", username: "b" }, { id: "3", username: "c" }]);
    criarSessao.mockResolvedValueOnce({ id: "s1" }).mockRejectedValueOnce(new Error("banco_caiu")).mockResolvedValueOnce({ id: "s3" });
    const r = await concluirConexaoMeta(db, ctx, { estado: estadoValido(), code: "COD" });
    expect(r.conectadas.map((c) => c.igId)).toEqual(["1", "3"]);
    expect(r.recusadas).toEqual([{ igId: "2", motivo: "falhou" }]);
  });

  it("corrida: a outra organização gravou a mesma conta no meio do caminho (conta_ja_conectada) vira recusa, não erro", async () => {
    criarSessao.mockRejectedValueOnce(new Error("conta_ja_conectada"));
    const r = await concluirConexaoMeta(db, ctx, { estado: estadoValido(), code: "COD" });
    expect(r.conectadas).toHaveLength(0);
    expect(r.recusadas).toEqual([{ igId: "1784", motivo: "ja_conectada_em_outra_organizacao" }]);
  });

  it("login com várias contas conecta cada uma", async () => {
    contasAtribuidas.mockResolvedValueOnce([{ id: "1", username: "a" }, { id: "2", username: "b" }]);
    const r = await concluirConexaoMeta(db, ctx, { estado: estadoValido(), code: "COD" });
    expect(r.conectadas.map((c) => c.igId)).toEqual(["1", "2"]);
  });
});
