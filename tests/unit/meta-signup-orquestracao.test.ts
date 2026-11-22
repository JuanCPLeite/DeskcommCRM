/**
 * `conectarPeloSignup` — a ORDEM do fluxo e os limites que ele respeita (#4074).
 *
 * A Meta e o banco são dublês: o que se prova aqui é a decisão do CRM — quem pode
 * abrir o fluxo, o que é tentado e em que ordem, o que NUNCA acontece (registrar
 * número em coexistência, gravar sessão de número que não é da conta, passar do
 * teto da empresa) e que nenhum token volta na resposta.
 *
 * O que só um app Tech Provider real prova — o token que a Meta de fato devolve, a
 * validade dele, o `phone_number_id` que a coexistência não traz — fica para a
 * conexão de um número de teste.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  signup: vi.fn(),
  app: vi.fn(),
  acesso: vi.fn(),
  troca: vi.fn(),
  descobrir: vi.fn(),
  registrar: vi.fn(),
  sincronizar: vi.fn(),
  validar: vi.fn(),
  webhook: vi.fn(),
  contar: vi.fn(),
  cifrar: vi.fn(),
  reativar: vi.fn(),
  origem: vi.fn(),
}));

vi.mock("@/lib/channels/meta/signup-config", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  signupDaMeta: h.signup,
}));
vi.mock("@/lib/channels/meta/app", () => ({ appDaMeta: h.app }));
vi.mock("@/lib/channels/meta/acesso-da-empresa", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  acessoDaEmpresa: h.acesso,
}));
vi.mock("@/lib/channels/meta/embedded-signup", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  trocarCodigoPorToken: h.troca,
  descobrirNumerosDaWaba: h.descobrir,
  registrarNumeroNaCloudApi: h.registrar,
  sincronizarCoexistencia: h.sincronizar,
}));
vi.mock("@/lib/channels/meta/validate-credentials", () => ({ validateMetaCredentials: h.validar }));
vi.mock("@/lib/channels/meta/webhook-da-sessao", () => ({ registrarWebhookDaSessao: h.webhook }));
vi.mock("@/lib/channels/meta/numeros-da-empresa", () => ({ contarNumerosAtivos: h.contar }));
vi.mock("@/lib/webhooks/secrets", () => ({ encryptWebhookSecret: h.cifrar }));
vi.mock("@/lib/channels/reactivate", () => ({ reactivateChannelSession: h.reativar }));
vi.mock("@/lib/channels/meta/origem-da-conexao", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  registrarOrigemDaConexao: h.origem,
}));

import { conectarPeloSignup, type EntradaDoSignup } from "@/lib/channels/meta/conectar-por-signup";

const ORG = "22222222-2222-4222-8222-222222222222";
const TOKEN_DA_META = "EAAG" + "t".repeat(60);
const CODE = "code-de-uso-unico-" + "c".repeat(20);

type Linha = Record<string, unknown>;

interface Banco {
  existente: Linha | null;
  insercoes: Linha[];
  upserts: Array<{ tabela: string; linha: Linha }>;
  erroDoInsert: { code?: string; message: string } | null;
  filtros: Array<[string, unknown]>;
}

function bancoDuble(over: Partial<Banco> = {}): { admin: EntradaDoSignup["admin"]; banco: Banco } {
  const banco: Banco = { existente: null, insercoes: [], upserts: [], erroDoInsert: null, filtros: [], ...over };
  const consulta = {
    select: () => consulta,
    eq: (c: string, v: unknown) => (banco.filtros.push([c, v]), consulta),
    is: () => consulta,
    maybeSingle: () => consulta,
    then: (ok: (r: unknown) => unknown, erro?: (e: unknown) => unknown) =>
      Promise.resolve({ data: banco.existente, error: null }).then(ok, erro),
  };
  const admin = {
    from: (tabela: string) => ({
      select: () => consulta,
      insert: (linha: Linha) => ({
        select: () => ({
          maybeSingle: async () => {
            if (banco.erroDoInsert) return { data: null, error: banco.erroDoInsert };
            banco.insercoes.push(linha);
            return { data: { id: "sessao-nova", webhook_path_token: "tok-novo-123456" }, error: null };
          },
        }),
      }),
      upsert: async (linha: Linha) => {
        banco.upserts.push({ tabela, linha });
        return { error: null };
      },
    }),
  } as unknown as EntradaDoSignup["admin"];
  return { admin, banco };
}

function entrada(admin: EntradaDoSignup["admin"], over: Partial<EntradaDoSignup> = {}): EntradaDoSignup {
  return {
    admin,
    organizationId: ORG,
    userId: "u1",
    idioma: "pt-BR",
    requestId: "req-1",
    base: "https://crm.test",
    code: CODE,
    wabaId: "1111111111",
    phoneNumberId: "2222222222",
    modo: "numero_novo",
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.signup.mockResolvedValue({ appId: "9999999999", configId: "8888888888", configIdCoexistencia: null, liberadoPorPadrao: false });
  h.app.mockResolvedValue({ appSecret: "segredo-do-app-" + "s".repeat(20), verifyToken: "vt" });
  h.acesso.mockResolvedValue({ embeddedSignup: true, coexistencia: true, maxNumeros: null });
  h.troca.mockResolvedValue({ ok: true, accessToken: TOKEN_DA_META });
  h.descobrir.mockResolvedValue({ ok: true, numeros: [{ id: "2222222222", displayPhoneNumber: "55 31 99999-0000", verifiedName: "Loja" }] });
  h.registrar.mockResolvedValue({ ok: true });
  h.sincronizar.mockResolvedValue({ contatos: { ok: true }, historico: { ok: true } });
  h.validar.mockResolvedValue({ ok: true, displayPhoneNumber: "55 31 99999-0000", verifiedName: "Loja", qualityRating: null });
  h.webhook.mockResolvedValue({ registrado: true, url: "https://crm.test/x", erro: null, em: "2026-11-22T00:00:00Z" });
  h.contar.mockResolvedValue(0);
  h.cifrar.mockImplementation(async (_a: unknown, valor: string) => `cifrado(${valor.length})`);
  h.reativar.mockResolvedValue({ error: null, schemaOutdated: false, reactivated: true });
  h.origem.mockResolvedValue({ gravada: true });
});

describe("antes de gastar o código — a recusa não toca a Meta", () => {
  it("app da instalação sem App Secret: 409 e o código NÃO é trocado", async () => {
    h.app.mockResolvedValue({ appSecret: null, verifyToken: null });
    const { admin } = bancoDuble();
    const r = await conectarPeloSignup(entrada(admin));
    expect(r).toMatchObject({ ok: false, status: 409, code: "meta_app_nao_configurado" });
    expect(h.troca).not.toHaveBeenCalled();
  });

  it("app sem App ID: 409", async () => {
    h.signup.mockResolvedValue({ appId: null, configId: null, configIdCoexistencia: null, liberadoPorPadrao: false });
    const { admin } = bancoDuble();
    expect(await conectarPeloSignup(entrada(admin))).toMatchObject({ ok: false, code: "meta_app_nao_configurado" });
    expect(h.troca).not.toHaveBeenCalled();
  });

  it("⭐ empresa NÃO liberada: 403 e o código NÃO é trocado", async () => {
    h.acesso.mockResolvedValue({ embeddedSignup: false, coexistencia: false, maxNumeros: null });
    const { admin, banco } = bancoDuble();
    const r = await conectarPeloSignup(entrada(admin));
    expect(r).toMatchObject({ ok: false, status: 403, code: "signup_nao_liberado" });
    expect(h.troca).not.toHaveBeenCalled();
    expect(banco.insercoes).toHaveLength(0);
  });

  it("coexistência não liberada: 403 só para o modo coexistência", async () => {
    h.acesso.mockResolvedValue({ embeddedSignup: true, coexistencia: false, maxNumeros: null });
    const { admin } = bancoDuble();
    const coex = await conectarPeloSignup(entrada(admin, { modo: "coexistencia", phoneNumberId: null }));
    expect(coex).toMatchObject({ ok: false, status: 403, code: "coexistencia_nao_liberada" });
    expect(h.troca).not.toHaveBeenCalled();

    const novo = await conectarPeloSignup(entrada(admin, { modo: "numero_novo" }));
    expect(novo.ok).toBe(true);
  });

  it("id de formato inválido é recusado sem chamar a Meta", async () => {
    const { admin } = bancoDuble();
    expect(await conectarPeloSignup(entrada(admin, { wabaId: "1; drop" }))).toMatchObject({ ok: false, status: 422 });
    expect(await conectarPeloSignup(entrada(admin, { phoneNumberId: "abc" }))).toMatchObject({ ok: false, status: 422 });
    expect(h.troca).not.toHaveBeenCalled();
  });
});

describe("número novo", () => {
  it("⭐ grava a sessão DA ORGANIZAÇÃO DA SESSÃO, registra o número e guarda o PIN cifrado à parte", async () => {
    const { admin, banco } = bancoDuble();
    const r = await conectarPeloSignup(entrada(admin));

    expect(r.ok).toBe(true);
    expect(banco.insercoes).toHaveLength(1);
    expect(banco.insercoes[0]).toMatchObject({
      organization_id: ORG,
      provider: expect.any(String),
      meta_phone_number_id: "2222222222",
      meta_waba_id: "1111111111",
      status: "WORKING",
    });

    // Prova o número contra a WABA com o token trocado — o navegador não é confiança.
    expect(h.validar).toHaveBeenCalledWith(expect.objectContaining({ phoneNumberId: "2222222222", wabaId: "1111111111", token: TOKEN_DA_META }));

    expect(h.registrar).toHaveBeenCalledTimes(1);
    expect(h.sincronizar).not.toHaveBeenCalled();

    const estado = banco.upserts.find((u) => u.tabela === "channel_session_meta_signup")!.linha;
    expect(estado).toMatchObject({ channel_session_id: "sessao-nova", organization_id: ORG, coexistencia: false });
    // O PIN vai CIFRADO (o dublê de cifra devolve `cifrado(n)`), nunca em claro.
    expect(String(estado.pin_encrypted)).toMatch(/^cifrado\(/);
  });

  it("a origem gravada é a constante embedded_signup — nunca a que o cliente pedir", async () => {
    const { admin } = bancoDuble();
    await conectarPeloSignup(entrada(admin));
    expect(h.origem).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ origem: "embedded_signup", organizationId: ORG }));
  });

  it("⭐ nenhum token, segredo, code ou PIN volta na resposta", async () => {
    const { admin } = bancoDuble();
    const r = await conectarPeloSignup(entrada(admin));
    const texto = JSON.stringify(r);
    expect(texto).not.toContain(TOKEN_DA_META);
    expect(texto).not.toContain(CODE);
    expect(texto).not.toContain("segredo-do-app");
    expect(texto).not.toMatch(/pin/i);
  });

  it("registro na Cloud API falhou: a conexão FICA de pé, com o motivo, e nenhum PIN é guardado", async () => {
    h.registrar.mockResolvedValue({ ok: false, motivo: "número já registrado em outro lugar" });
    const { admin, banco } = bancoDuble();
    const r = await conectarPeloSignup(entrada(admin));
    expect(r).toMatchObject({ ok: true, registro: { ok: false, motivo: "número já registrado em outro lugar" } });
    expect(banco.insercoes).toHaveLength(1);
    expect(banco.upserts.find((u) => u.tabela === "channel_session_meta_signup")!.linha.pin_encrypted).toBeNull();
  });

  it("webhook que a Meta recusou NÃO desfaz a conexão", async () => {
    h.webhook.mockResolvedValue({ registrado: false, url: null, erro: "sem permissão", em: "x" });
    const { admin, banco } = bancoDuble();
    const r = await conectarPeloSignup(entrada(admin));
    expect(r).toMatchObject({ ok: true, webhookRegistro: { registrado: false, erro: "sem permissão" } });
    expect(banco.insercoes).toHaveLength(1);
  });
});

describe("coexistência", () => {
  it("⭐ NUNCA registra o número (ele já está registrado no app) e pede a sincronização UMA vez", async () => {
    const { admin, banco } = bancoDuble();
    const r = await conectarPeloSignup(entrada(admin, { modo: "coexistencia", phoneNumberId: null }));

    expect(r.ok).toBe(true);
    expect(h.registrar).not.toHaveBeenCalled();
    expect(h.sincronizar).toHaveBeenCalledTimes(1);

    const estado = banco.upserts.find((u) => u.tabela === "channel_session_meta_signup")!.linha;
    expect(estado).toMatchObject({ coexistencia: true, pin_encrypted: null });
    expect(estado.contatos_pedidos_em).toEqual(expect.any(String));
    expect(estado.historico_pedido_em).toEqual(expect.any(String));
  });

  it("sem phone_number_id no evento: descobre pela WABA com o token trocado", async () => {
    const { admin, banco } = bancoDuble();
    await conectarPeloSignup(entrada(admin, { modo: "coexistencia", phoneNumberId: null }));
    expect(h.descobrir).toHaveBeenCalledWith({ wabaId: "1111111111", token: TOKEN_DA_META });
    expect(banco.insercoes[0]).toMatchObject({ meta_phone_number_id: "2222222222" });
  });

  it("⭐ conta com mais de um número: NÃO adivinha — conectar o errado põe a mensagem de um cliente no inbox de outro", async () => {
    h.descobrir.mockResolvedValue({
      ok: true,
      numeros: [
        { id: "2222222222", displayPhoneNumber: null, verifiedName: null },
        { id: "3333333333", displayPhoneNumber: null, verifiedName: null },
      ],
    });
    const { admin, banco } = bancoDuble();
    const r = await conectarPeloSignup(entrada(admin, { modo: "coexistencia", phoneNumberId: null }));
    expect(r).toMatchObject({ ok: false, status: 409, code: "varios_numeros_na_conta" });
    expect(banco.insercoes).toHaveLength(0);
  });

  it("conta sem número algum: recusa com o que fazer", async () => {
    h.descobrir.mockResolvedValue({ ok: true, numeros: [] });
    const { admin } = bancoDuble();
    expect(await conectarPeloSignup(entrada(admin, { modo: "coexistencia", phoneNumberId: null }))).toMatchObject({
      ok: false,
      code: "varios_numeros_na_conta",
    });
  });

  it("sincronização que a Meta recusou: a conexão fica e o motivo é gravado", async () => {
    h.sincronizar.mockResolvedValue({ contatos: { ok: true }, historico: { ok: false, motivo: "prazo de 24h vencido" } });
    const { admin, banco } = bancoDuble();
    const r = await conectarPeloSignup(entrada(admin, { modo: "coexistencia" }));
    expect(r.ok).toBe(true);
    const estado = banco.upserts.find((u) => u.tabela === "channel_session_meta_signup")!.linha;
    expect(estado.historico_pedido_em).toBeNull();
    expect(estado.sincronizacao_erro).toContain("prazo de 24h vencido");
  });
});

describe("o código e o número — o navegador não é confiança", () => {
  it("troca recusada pela Meta: 422 e nada é gravado", async () => {
    h.troca.mockResolvedValue({ ok: false, motivo: "code expirado" });
    const { admin, banco } = bancoDuble();
    const r = await conectarPeloSignup(entrada(admin));
    expect(r).toMatchObject({ ok: false, status: 422, code: "troca_do_codigo_recusada" });
    expect((r as { message: string }).message).toContain("code expirado");
    expect(banco.insercoes).toHaveLength(0);
    expect(h.validar).not.toHaveBeenCalled();
  });

  it("⭐ número que NÃO é da conta informada: 422 e nada é gravado", async () => {
    h.validar.mockResolvedValue({ ok: false, motivo: "o número não pertence a esta conta" });
    const { admin, banco } = bancoDuble();
    const r = await conectarPeloSignup(entrada(admin));
    expect(r).toMatchObject({ ok: false, status: 422 });
    expect(banco.insercoes).toHaveLength(0);
    expect(h.registrar).not.toHaveBeenCalled();
  });

  it("sem cifra na instalação: recusa em vez de gravar o token em claro", async () => {
    h.cifrar.mockResolvedValue(null);
    const { admin, banco } = bancoDuble();
    expect(await conectarPeloSignup(entrada(admin))).toMatchObject({ ok: false, code: "cifra_indisponivel" });
    expect(banco.insercoes).toHaveLength(0);
  });
});

describe("vários números e o teto da empresa", () => {
  it("⭐ no teto: número NOVO é recusado (409) e nada é gravado", async () => {
    h.acesso.mockResolvedValue({ embeddedSignup: true, coexistencia: true, maxNumeros: 2 });
    h.contar.mockResolvedValue(2);
    const { admin, banco } = bancoDuble();
    const r = await conectarPeloSignup(entrada(admin));
    expect(r).toMatchObject({ ok: false, status: 409, code: "limite_da_empresa" });
    expect(banco.insercoes).toHaveLength(0);
    expect(h.registrar).not.toHaveBeenCalled();
  });

  it("abaixo do teto: conecta mais um", async () => {
    h.acesso.mockResolvedValue({ embeddedSignup: true, coexistencia: true, maxNumeros: 3 });
    h.contar.mockResolvedValue(2);
    const { admin, banco } = bancoDuble();
    expect((await conectarPeloSignup(entrada(admin))).ok).toBe(true);
    expect(banco.insercoes).toHaveLength(1);
  });

  it("⭐ no teto, RECONECTAR um número que a empresa já tem não ocupa vaga e é aceito", async () => {
    h.acesso.mockResolvedValue({ embeddedSignup: true, coexistencia: true, maxNumeros: 1 });
    h.contar.mockResolvedValue(1);
    const { admin, banco } = bancoDuble({
      existente: { id: "sessao-existente", archived_at: null, webhook_path_token: "tok-existente-12", display_name: "Loja" },
    });
    const r = await conectarPeloSignup(entrada(admin));
    expect(r).toMatchObject({ ok: true, channelSessionId: "sessao-existente" });
    // Reaproveitou a MESMA linha: nenhuma duplicata.
    expect(banco.insercoes).toHaveLength(0);
    expect(h.reativar).toHaveBeenCalledTimes(1);
  });

  it("a busca da sessão existente é pelo NÚMERO e filtra a organização", async () => {
    const { admin, banco } = bancoDuble();
    await conectarPeloSignup(entrada(admin));
    expect(banco.filtros).toEqual(
      expect.arrayContaining([
        ["organization_id", ORG],
        ["meta_phone_number_id", "2222222222"],
      ]),
    );
  });

  it("número já ATIVO em outra empresa (índice da 0165): 409 numero_em_uso", async () => {
    const { admin } = bancoDuble({ erroDoInsert: { code: "23505", message: "duplicate key" } });
    expect(await conectarPeloSignup(entrada(admin))).toMatchObject({ ok: false, status: 409, code: "numero_em_uso" });
  });

  it("acima do limite do PLANO (gatilho do banco): devolve a frase do plano", async () => {
    const { admin } = bancoDuble({
      erroDoInsert: { code: "PT402", message: "limite_do_plano:canais:1" },
    });
    const r = await conectarPeloSignup(entrada(admin));
    expect(r).toMatchObject({ ok: false, status: 409, code: "plan_limit_reached" });
  });
});
