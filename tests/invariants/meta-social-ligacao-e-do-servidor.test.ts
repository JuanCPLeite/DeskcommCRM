import { beforeAll, describe, expect, it } from "vitest";

import { GOV_ADMIN, GOV_ORG, seedGov, sql } from "./gov-helpers";
import { motivoDoErro } from "./psql-transporte";

/**
 * A LIGAÇÃO DO CANAL DIRETO COM A META É DO SERVIDOR (migration 9513).
 *
 * `social_account_id` decide a que organização o webhook da Meta entrega as DMs
 * daquela conta, e `social_token_encrypted` é o acesso a ela. A tabela tem
 * GRANT ALL para `authenticated` e as policies deixam o admin da organização
 * alterar a própria linha direto pela API do banco: sem esta trava, um admin
 * "reservaria" a conta Instagram de outra empresa (o índice único passaria a
 * barrar a conexão legítima dela) e plantaria um token. Mesma regra, mesma
 * função e mesmo código de recusa das colunas do WhatsApp oficial (9104).
 */

const RECUSA = "canal_ligacao_ao_provedor_e_do_servidor";
const CANAL = "cccccccc-9513-4000-8000-000000000001";

const LINHA = `
  insert into public.channel_sessions
    (id, organization_id, provider, social_account_id, social_token_encrypted,
     webhook_path_token, webhook_secret_encrypted, display_name, archived_at)
  values ('${CANAL}', '${GOV_ORG}', 'meta_social', '17841400009513001', '\\x01'::bytea,
     'tok-9513-inv', '\\x00'::bytea, 'Instagram 9513', now());`;

function comoAdmin(dml: string): string {
  return sql(`
    begin;
    ${LINHA}
    set local role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${GOV_ADMIN}","role":"authenticated"}', true) is not null;
    with w as (${dml} returning 1) select 'LINHAS:' || count(*) from w;
    rollback;`);
}

function comoServidor(dml: string): string {
  return sql(`
    begin;
    ${LINHA}
    set local role service_role;
    with w as (${dml} returning 1) select 'LINHAS:' || count(*) from w;
    rollback;`);
}

function erroDe(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return motivoDoErro(err);
  }
}

/** Uma linha nova, arquivada, com UMA coluna da ligação preenchida (ou nenhuma). */
function insercao(coluna: string | null, valor = "null"): string {
  const provedor = coluna === "social_account_id" ? "'meta_social'" : "'waha'";
  const ref = coluna === "social_account_id" ? "null" : "'inv-9513-insert'";
  const extra = coluna ? `, ${coluna}` : "";
  const v = coluna ? `, ${valor}` : "";
  return `insert into public.channel_sessions
      (organization_id, provider, waha_session_name, webhook_path_token, webhook_secret_encrypted, archived_at${extra})
    values ('${GOV_ORG}', ${provedor}, ${ref}, 'tok-9513-insert', '\\x00'::bytea, now()${v})`;
}

const COLUNAS: Array<[string, string]> = [
  ["social_account_id", "'17841400009513999'"],
  ["social_token_encrypted", "'\\x02'::bytea"],
  ["social_token_expires_at", "now()"],
];

beforeAll(() => {
  seedGov();
});

describe("9513: o admin da organização não grava a ligação do canal direto com a Meta", () => {
  it.each(COLUNAS)("UPDATE de %s na própria linha: 42501", (coluna, valor) => {
    const erro = erroDe(() => comoAdmin(`update public.channel_sessions set ${coluna} = ${valor} where id = '${CANAL}'`));
    expect(erro, `o admin alterou ${coluna} SEM erro`).not.toBeNull();
    expect(erro).toContain(RECUSA);
  });

  it("UPDATE que zera o token: 42501 (a desconexão zera pelo service role)", () => {
    const erro = erroDe(() => comoAdmin(`update public.channel_sessions set social_token_encrypted = null where id = '${CANAL}'`));
    expect(erro, "o admin zerou o token SEM erro").not.toBeNull();
    expect(erro).toContain(RECUSA);
  });

  it.each(COLUNAS.slice(0, 2))("INSERT com %s: 42501", (coluna, valor) => {
    const erro = erroDe(() => comoAdmin(insercao(coluna, valor)));
    expect(erro, `o admin inseriu ${coluna} SEM erro`).not.toBeNull();
    expect(erro).toContain(RECUSA);
  });

  it("DESARQUIVAR a própria linha desconectada: 42501 (senão o admin 'reserva' a conta e recebe o webhook dela)", () => {
    const erro = erroDe(() => comoAdmin(`update public.channel_sessions set archived_at = null where id = '${CANAL}'`));
    expect(erro, "o admin desarquivou o canal direto SEM erro").not.toBeNull();
    expect(erro).toContain(RECUSA);
  });

  it("CONTROLE: o MESMO admin renomeia a MESMA linha", () => {
    expect(comoAdmin(`update public.channel_sessions set display_name = 'Renomeado 9513' where id = '${CANAL}'`)).toContain("LINHAS:1");
  });

  it("CONTROLE: reescrever o MESMO valor não é alteração", () => {
    expect(
      comoAdmin(`
        update public.channel_sessions
           set social_account_id = social_account_id, social_token_encrypted = social_token_encrypted,
               social_token_expires_at = social_token_expires_at
         where id = '${CANAL}'`),
    ).toContain("LINHAS:1");
  });

  it("CONTROLE: o MESMO admin insere uma linha sem as colunas do canal direto", () => {
    expect(comoAdmin(insercao(null))).toContain("LINHAS:1");
  });
});

describe("9513: o servidor (service role) grava a ligação do canal direto", () => {
  it("UPDATE das três colunas", () => {
    expect(
      comoServidor(`
        update public.channel_sessions
           set social_account_id = '17841400009513002', social_token_encrypted = '\\x02'::bytea,
               social_token_expires_at = now()
         where id = '${CANAL}'`),
    ).toContain("LINHAS:1");
  });

  it("desarquivar pelo servidor é permitido (a reconexão legítima)", () => {
    expect(comoServidor(`update public.channel_sessions set archived_at = null where id = '${CANAL}'`)).toContain("LINHAS:1");
  });

  it("UPDATE que zera o token (o que a desconexão faz)", () => {
    expect(comoServidor(`update public.channel_sessions set social_token_encrypted = null where id = '${CANAL}'`)).toContain("LINHAS:1");
  });
});
