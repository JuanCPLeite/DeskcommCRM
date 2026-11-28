import { describe, expect, it } from "vitest";
import { sql } from "./gov-helpers";

/**
 * O canal DIRETO com a Meta (Instagram/Facebook): migration 9513.
 *
 * Prova o que o banco decide e o TypeScript não vê: o vocabulário do provider, a
 * coluna de endereço do canal, a unicidade da conta entre organizações e a
 * tabela de credenciais do app (exclusiva do servidor).
 */
const ORG_A = "20000000-0000-4000-8000-0000000000a1";
const ORG_B = "20000000-0000-4000-8000-0000000000b2";

describe("canal meta_social — schema", () => {
  it("aceita o provider novo com a conta Meta e recusa sem ela", () => {
    sql(`insert into organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}','meta-social-a','Meta A','Meta A'),
      ('${ORG_B}','meta-social-b','Meta B','Meta B');`);
    sql(`insert into channel_sessions (organization_id, provider, social_account_id, status, webhook_secret_encrypted)
      values ('${ORG_A}','meta_social','17841400000000001','WORKING','\\x00');`);
    expect(() =>
      sql(`insert into channel_sessions (organization_id, provider, status, webhook_secret_encrypted)
        values ('${ORG_A}','meta_social','WORKING','\\x00');`),
    ).toThrow(/channel_sessions_provider_ref_check/);
  });

  it("controle: os providers que já existiam continuam aceitos", () => {
    for (const [provider, coluna, valor] of [
      ["waha", "waha_session_name", "meta-social-ctl-waha"],
      ["zernio_social", "zernio_account_id", "meta-social-ctl-zs"],
      ["telegram", "telegram_bot_id", "meta-social-ctl-tg"],
    ] as const) {
      sql(`insert into channel_sessions (organization_id, provider, ${coluna}, status, webhook_secret_encrypted)
        values ('${ORG_A}','${provider}','${valor}','WORKING','\\x00');`);
    }
    expect(
      sql(`select count(*) from channel_sessions where organization_id = '${ORG_A}' and provider in ('waha','zernio_social','telegram')`),
    ).toBe("3");
  });

  it("a mesma conta Meta ativa não pode estar em duas organizações; arquivada, pode", () => {
    expect(() =>
      sql(`insert into channel_sessions (organization_id, provider, social_account_id, status, webhook_secret_encrypted)
        values ('${ORG_B}','meta_social','17841400000000001','WORKING','\\x00');`),
    ).toThrow(/duplicate key|unique/i);
    sql(`update channel_sessions set archived_at = now() where social_account_id = '17841400000000001';`);
    sql(`insert into channel_sessions (organization_id, provider, social_account_id, status, webhook_secret_encrypted)
      values ('${ORG_B}','meta_social','17841400000000001','WORKING','\\x00');`);
    expect(
      sql(`select count(*) from channel_sessions where social_account_id = '17841400000000001' and archived_at is null`),
    ).toBe("1");
  });

  it("guarda o token cifrado em coluna própria, que o navegador não lê", () => {
    expect(
      sql(`select count(*) from information_schema.columns where table_name = 'channel_sessions'
        and column_name in ('meta_social_token_encrypted','meta_social_token_expires_at','social_account_id')`),
    ).toBe("3");
  });
});

describe("platform_meta_social_app — credenciais do app, exclusivas do servidor", () => {
  it("anon e authenticated não leem nem escrevem; RLS ligada", () => {
    for (const role of ["anon", "authenticated"]) {
      for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        expect(sql(`select has_table_privilege('${role}', 'public.platform_meta_social_app', '${priv}')`)).toBe("f");
      }
    }
    expect(sql("select relrowsecurity from pg_class where oid = 'public.platform_meta_social_app'::regclass")).toBe("t");
    expect(sql("select has_table_privilege('service_role', 'public.platform_meta_social_app', 'SELECT')")).toBe("t");
  });

  it("é uma linha só (singleton)", () => {
    sql(`insert into platform_meta_social_app (id, app_id) values (1, '1686546369790015');`);
    expect(() => sql(`insert into platform_meta_social_app (id, app_id) values (2, 'outra');`)).toThrow();
    expect(sql("select count(*) from platform_meta_social_app")).toBe("1");
  });
});
