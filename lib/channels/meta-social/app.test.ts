import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * AS CREDENCIAIS DO APP META SOCIAL (Instagram/Facebook) DA INSTALAÇÃO.
 *
 * Mesmas três propriedades de `app-da-meta-credencial-do-banco.test.ts`, para o
 * app do canal DIRETO: banco primeiro; `.env` como piso de rollback; e o par
 * (chave secreta + token de verificação) sai INTEIRO de uma fonte só — a chave
 * de um app com o token de outro faz o handshake passar e toda entrega morrer
 * em 401. Os dois identificadores (app e configuração do login) são públicos e
 * resolvem campo a campo.
 */

const ORIGINAL = { ...process.env };

type Linha = {
  app_id: string | null;
  login_config_id: string | null;
  app_secret_encrypted: string | null;
  verify_token_encrypted: string | null;
};

let linhaDoBanco: Linha | null = null;
let erroDaLeitura: { code: string; message: string } | null = null;
let estoura: Error | null = null;
let leituras = 0;
let decifrado: Record<string, string | null> = {};

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          abortSignal: () => ({
            maybeSingle: async () => {
              leituras += 1;
              if (estoura) throw estoura;
              return { data: linhaDoBanco, error: erroDaLeitura };
            },
          }),
        }),
      }),
    }),
  }),
}));

vi.mock("@/lib/webhooks/secrets", () => ({
  decryptWebhookSecret: async (_admin: unknown, cifrado: string) => decifrado[cifrado] ?? null,
}));

const NO_ENV = {
  META_SOCIAL_APP_ID: "app-do-env",
  META_SOCIAL_LOGIN_CONFIG_ID: "config-do-env",
  META_SOCIAL_APP_SECRET: "segredo-do-env",
  META_SOCIAL_VERIFY_TOKEN: "token-do-env",
};

const SEM_ENV = {
  META_SOCIAL_APP_ID: undefined,
  META_SOCIAL_LOGIN_CONFIG_ID: undefined,
  META_SOCIAL_APP_SECRET: undefined,
  META_SOCIAL_VERIFY_TOKEN: undefined,
};

async function importarComEnv(vars: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const mod = await import("@/lib/channels/meta-social/app");
  // O memo mora no `globalThis`: `resetModules` não o limpa.
  mod.invalidarAppSocialDaMeta();
  return mod;
}

const LINHA_CHEIA: Linha = {
  app_id: "app-do-banco",
  login_config_id: "config-do-banco",
  app_secret_encrypted: "\\xSEGREDO",
  verify_token_encrypted: "\\xTOKEN",
};

beforeEach(() => {
  linhaDoBanco = null;
  erroDaLeitura = null;
  estoura = null;
  leituras = 0;
  decifrado = { "\\xSEGREDO": "segredo-do-banco", "\\xTOKEN": "token-do-banco" };
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe("appSocialDaMeta — precedência", () => {
  it("o banco vence o .env, nos quatro campos", async () => {
    linhaDoBanco = LINHA_CHEIA;
    const { appSocialDaMeta } = await importarComEnv(NO_ENV);
    expect(await appSocialDaMeta()).toEqual({
      appId: "app-do-banco",
      loginConfigId: "config-do-banco",
      appSecret: "segredo-do-banco",
      verifyToken: "token-do-banco",
    });
  });

  it("sem linha no banco, vale o .env", async () => {
    const { appSocialDaMeta } = await importarComEnv(NO_ENV);
    expect(await appSocialDaMeta()).toEqual({
      appId: "app-do-env",
      loginConfigId: "config-do-env",
      appSecret: "segredo-do-env",
      verifyToken: "token-do-env",
    });
  });

  it("instalação sem nada configurado devolve tudo nulo, sem lançar", async () => {
    const { appSocialDaMeta } = await importarComEnv(SEM_ENV);
    expect(await appSocialDaMeta()).toEqual({
      appId: null,
      loginConfigId: null,
      appSecret: null,
      verifyToken: null,
    });
  });

  it("vazio ou só espaços no .env é ausente", async () => {
    const { appSocialDaMeta } = await importarComEnv({ ...NO_ENV, META_SOCIAL_APP_SECRET: "   ", META_SOCIAL_APP_ID: "" });
    const r = await appSocialDaMeta();
    expect(r.appSecret).toBeNull();
    expect(r.appId).toBeNull();
  });

  it("os identificadores públicos resolvem campo a campo (banco só com o ID do app)", async () => {
    linhaDoBanco = { ...LINHA_CHEIA, login_config_id: null, app_secret_encrypted: null, verify_token_encrypted: null };
    const { appSocialDaMeta } = await importarComEnv(NO_ENV);
    const r = await appSocialDaMeta();
    expect(r.appId).toBe("app-do-banco");
    expect(r.loginConfigId).toBe("config-do-env");
  });
});

describe("appSocialDaMeta — o par de segredos não se mistura", () => {
  it("só a chave no banco (sem token): cai INTEIRO para o .env", async () => {
    linhaDoBanco = { ...LINHA_CHEIA, verify_token_encrypted: null };
    const { appSocialDaMeta } = await importarComEnv(NO_ENV);
    const r = await appSocialDaMeta();
    expect(r.appSecret).toBe("segredo-do-env");
    expect(r.verifyToken).toBe("token-do-env");
  });

  it("o par do banco que não decifra (chave mestra trocada): cai inteiro para o .env", async () => {
    linhaDoBanco = LINHA_CHEIA;
    decifrado = {};
    const { appSocialDaMeta } = await importarComEnv(NO_ENV);
    const r = await appSocialDaMeta();
    expect(r.appSecret).toBe("segredo-do-env");
    expect(r.verifyToken).toBe("token-do-env");
  });
});

describe("appSocialDaMeta — nunca lança (é chamada a cada entrega da Meta)", () => {
  it("erro devolvido pelo banco (tabela ausente) → vale o .env", async () => {
    erroDaLeitura = { code: "42P01", message: "relation does not exist" };
    const { appSocialDaMeta } = await importarComEnv(NO_ENV);
    expect((await appSocialDaMeta()).appSecret).toBe("segredo-do-env");
  });

  it("leitura que estoura → vale o .env", async () => {
    estoura = new Error("rede caiu");
    const { appSocialDaMeta } = await importarComEnv(NO_ENV);
    expect((await appSocialDaMeta()).appSecret).toBe("segredo-do-env");
  });
});

describe("appSocialDaMeta — memo", () => {
  it("duas chamadas seguidas consultam o banco uma vez; invalidar força nova leitura", async () => {
    linhaDoBanco = LINHA_CHEIA;
    const { appSocialDaMeta, invalidarAppSocialDaMeta } = await importarComEnv(SEM_ENV);
    await appSocialDaMeta();
    await appSocialDaMeta();
    expect(leituras).toBe(1);
    invalidarAppSocialDaMeta();
    await appSocialDaMeta();
    expect(leituras).toBe(2);
  });
});
