import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A rota que inicia e conclui a conexão de contas Instagram pelo login unificado.
 * Mede as GUARDAS (papel, MFA, suporte, formato) e o mapa de erros, com o fluxo
 * (`conectar.ts`) substituído — ele tem os testes dele.
 */

const iniciar = vi.fn(async () => ({ url: "https://www.facebook.com/dialog/oauth?x=1" }));
const concluir = vi.fn(async () => ({
  conectadas: [{ channelId: "canal-1", igId: "1784", username: "loja", webhookAssinado: true }],
  recusadas: [] as { igId: string; motivo: string }[],
}));
const audit = vi.fn();
let papelOk = true;
let mfaPendente = false;
let suporteBloqueia = false;
let limiteOk = true;

vi.mock("@/lib/impersonate/support", () => ({
  requireSupportWrite: async () => (suporteBloqueia ? new Response(null, { status: 403 }) : null),
}));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async () =>
    papelOk
      ? { ok: true, user: { id: "user-1", idioma: "pt-BR" }, org: { orgId: "org-A", name: "Empresa A" } }
      : { ok: false, response: new Response(JSON.stringify({ error: { code: "forbidden" } }), { status: 403 }) },
}));
vi.mock("@/lib/auth/server", () => ({ mfaEmDivida: async () => mfaPendente }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: async () => ({ allowed: limiteOk }) }));
vi.mock("@/lib/audit", () => ({ audit: (...a: unknown[]) => audit(...a) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/webhooks/url-publica", () => ({
  basePublicaConfiguradaDaInstalacao: () => "https://crm.exemplo.com",
}));
vi.mock("@/lib/env", () => ({ env: { INTERNAL_SECRET: "segredo-interno-com-mais-de-dezesseis" } }));
vi.mock("@/lib/channels/meta-social/conectar", async () => {
  const real = await vi.importActual<typeof import("@/lib/channels/meta-social/conectar")>("@/lib/channels/meta-social/conectar");
  return {
    ...real,
    iniciarConexaoMeta: (...a: unknown[]) => iniciar(...(a as [])),
    concluirConexaoMeta: (...a: unknown[]) => concluir(...(a as [])),
  };
});

import { ErroDaConexaoMeta } from "@/lib/channels/meta-social/conectar";
import { POST } from "./route";

const ESTADO = `${"A".repeat(40)}.${"a".repeat(64)}`;

function req(corpo: unknown) {
  return new Request("https://crm.exemplo.com/api/v1/channels/meta-social", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(corpo),
  }) as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  papelOk = true;
  mfaPendente = false;
  suporteBloqueia = false;
  limiteOk = true;
});

describe("POST /api/v1/channels/meta-social", () => {
  it("iniciar devolve a URL do diálogo da Meta", async () => {
    const r = await POST(req({ acao: "iniciar" }));
    expect(r.status).toBe(200);
    expect((await r.json()).data.url).toContain("facebook.com/dialog/oauth");
  });

  it("concluir devolve as contas conectadas e audita sem o token", async () => {
    const r = await POST(req({ acao: "concluir", estado: ESTADO, code: "CODIGO-DA-META-123" }));
    expect(r.status).toBe(200);
    const corpo = await r.json();
    expect(corpo.data.conectadas[0]).toMatchObject({ channel_id: "canal-1", username: "loja" });
    expect(JSON.stringify(audit.mock.calls)).not.toContain("CODIGO-DA-META");
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "channel.connected", organizationId: "org-A" }));
  });

  it("recusa quem não é admin, quem está em suporte, e quem deve a verificação em duas etapas", async () => {
    papelOk = false;
    expect((await POST(req({ acao: "iniciar" }))).status).toBe(403);
    papelOk = true;
    suporteBloqueia = true;
    expect((await POST(req({ acao: "iniciar" }))).status).toBe(403);
    suporteBloqueia = false;
    mfaPendente = true;
    const r = await POST(req({ acao: "iniciar" }));
    expect(r.status).toBe(403);
    expect((await r.json()).error.code).toBe("mfa_required");
    expect(iniciar).not.toHaveBeenCalled();
  });

  it("corpo fora do formato é 400, e o excesso de tentativas é 429", async () => {
    expect((await POST(req({ acao: "concluir", estado: "curto", code: "x" }))).status).toBe(400);
    expect((await POST(req({ acao: "outra" }))).status).toBe(400);
    limiteOk = false;
    expect((await POST(req({ acao: "iniciar" }))).status).toBe(429);
  });

  it("app não configurado vira 422 com o que falta; estado inválido vira 400", async () => {
    iniciar.mockRejectedValueOnce(new ErroDaConexaoMeta("app_nao_configurado", "x", ["appSecret"]));
    const a = await POST(req({ acao: "iniciar" }));
    expect(a.status).toBe(422);
    expect((await a.json()).error.code).toBe("app_nao_configurado");
    concluir.mockRejectedValueOnce(new ErroDaConexaoMeta("estado_invalido", "x"));
    expect((await POST(req({ acao: "concluir", estado: ESTADO, code: "CODIGO-DA-META-123" }))).status).toBe(400);
  });

  it("conta já conectada em outra organização aparece como recusada, sem erro HTTP", async () => {
    concluir.mockResolvedValueOnce({ conectadas: [], recusadas: [{ igId: "1784", motivo: "ja_conectada_em_outra_organizacao" }] });
    const r = await POST(req({ acao: "concluir", estado: ESTADO, code: "CODIGO-DA-META-123" }));
    expect(r.status).toBe(200);
    expect((await r.json()).data.recusadas).toEqual([{ ig_id: "1784", motivo: "ja_conectada_em_outra_organizacao" }]);
  });
});
