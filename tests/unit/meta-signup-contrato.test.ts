/**
 * O CONTRATO do Embedded Signup (#4074): as regras puras que decidem o que vai ao
 * navegador, o que se aceita de volta e quem pode abrir a janela.
 *
 * Nada aqui fala com a Meta nem com o banco — é o recorte que se prova sem um app
 * Tech Provider real. O que depende de um app de verdade (o token que a Meta devolve,
 * o `phone_number_id` que a coexistência não traz) fica provado pela conexão de um
 * número de teste, e o teste do orquestrador (`meta-signup-orquestracao.test.ts`)
 * garante que cada passo desse caminho é tentado na ordem certa.
 */
import { describe, expect, it } from "vitest";

import { cabeMaisUmNumero, resolverAcesso } from "@/lib/channels/meta/acesso-da-empresa";
import { extrasDoSignup, gerarPinDoNumero, VERSAO_DO_SIGNUP } from "@/lib/channels/meta/embedded-signup";
import { idDaMetaValido, signupDaLinha, signupDoAmbiente } from "@/lib/channels/meta/signup-config";
import { lerEventoDoSignup, origemEhDaMeta } from "@/lib/channels/meta/signup-evento";

describe("extrasDoSignup — o que vai ao FB.login", () => {
  it("número novo desliga a coexistência: a janela não oferece o que a empresa não foi liberada para usar", () => {
    const e = extrasDoSignup("numero_novo");
    expect(e.version).toBe(VERSAO_DO_SIGNUP);
    expect(e.setup).toEqual({});
    expect(e.features).toEqual([{ name: "whatsapp_business_app_onboarding", enabled: false }]);
  });

  it("coexistência usa o padrão da versão (ligada) e não carrega o opt-out", () => {
    const e = extrasDoSignup("coexistencia");
    expect(e.version).toBe(VERSAO_DO_SIGNUP);
    expect(e).not.toHaveProperty("features");
  });
});

describe("origemEhDaMeta — o postMessage é um canal aberto", () => {
  it.each([
    ["https://www.facebook.com", true],
    ["https://web.facebook.com", true],
    ["https://facebook.com", true],
    // `endsWith("facebook.com")` puro aceitaria estes três:
    ["https://evilfacebook.com", false],
    ["https://facebook.com.evil.example", false],
    ["http://www.facebook.com", false],
    ["null", false],
    ["", false],
  ])("%s → %s", (origem, esperado) => {
    expect(origemEhDaMeta(origem)).toBe(esperado);
  });
});

describe("lerEventoDoSignup — só o que tem o formato esperado vira dado", () => {
  const msg = (event: string, data: unknown) => JSON.stringify({ type: "WA_EMBEDDED_SIGNUP", event, data });

  it("FINISH traz a conta e o número", () => {
    expect(lerEventoDoSignup(msg("FINISH", { waba_id: "123456789", phone_number_id: "987654321" }))).toEqual({
      tipo: "concluido",
      evento: "FINISH",
      wabaId: "123456789",
      phoneNumberId: "987654321",
    });
  });

  it("coexistência: sem phone_number_id é o caso ESPERADO, não um erro", () => {
    expect(lerEventoDoSignup(msg("FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING", { waba_id: "123456789" }))).toEqual({
      tipo: "concluido",
      evento: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING",
      wabaId: "123456789",
      phoneNumberId: null,
    });
  });

  it("id que não é numérico é descartado — nunca repassado ao servidor", () => {
    const e = lerEventoDoSignup(msg("FINISH", { waba_id: "1; drop table", phone_number_id: "abc" }));
    expect(e).toMatchObject({ tipo: "concluido", wabaId: null, phoneNumberId: null });
  });

  it("aceita o objeto já parseado e rejeita outro tipo de mensagem", () => {
    expect(lerEventoDoSignup({ type: "WA_EMBEDDED_SIGNUP", event: "CANCEL", data: { current_step: "PHONE" } })).toEqual({
      tipo: "cancelado",
      etapa: "PHONE",
    });
    expect(lerEventoDoSignup({ type: "OUTRA_COISA", event: "FINISH", data: {} })).toBeNull();
    expect(lerEventoDoSignup("isto não é json")).toBeNull();
    expect(lerEventoDoSignup(null)).toBeNull();
  });

  it("ERROR devolve o motivo, truncado", () => {
    const e = lerEventoDoSignup(msg("ERROR", { error_message: "x".repeat(500), error_code: "100" }));
    expect(e).toMatchObject({ tipo: "erro", codigo: "100" });
    expect((e as { mensagem: string }).mensagem).toHaveLength(200);
  });
});

describe("resolverAcesso — herança em três estados, e a instalação NÃO é teto", () => {
  it("sem linha herda o padrão da instalação", () => {
    expect(resolverAcesso(null, false)).toEqual({ embeddedSignup: false, coexistencia: false, maxNumeros: null });
    expect(resolverAcesso(null, true)).toEqual({ embeddedSignup: true, coexistencia: true, maxNumeros: null });
  });

  it("⭐ padrão BLOQUEADO + empresa liberada = liberada (quem revende libera só o cliente que contratou)", () => {
    expect(resolverAcesso({ embedded_signup: true }, false).embeddedSignup).toBe(true);
  });

  it("padrão LIBERADO + empresa bloqueada = bloqueada", () => {
    expect(resolverAcesso({ embedded_signup: false }, true).embeddedSignup).toBe(false);
  });

  it("coexistência é um modo DO Embedded Signup: sem ele, não vale mesmo liberada", () => {
    expect(resolverAcesso({ embedded_signup: false, coexistencia: true }, false).coexistencia).toBe(false);
    expect(resolverAcesso({ embedded_signup: true, coexistencia: true }, false).coexistencia).toBe(true);
    // Liberou o signup mas bloqueou a coexistência:
    expect(resolverAcesso({ embedded_signup: true, coexistencia: false }, true).coexistencia).toBe(false);
  });

  it("max_numeros inválido vira 'sem teto da empresa', nunca um teto estranho", () => {
    expect(resolverAcesso({ max_numeros: -1 }, true).maxNumeros).toBeNull();
    expect(resolverAcesso({ max_numeros: 1.5 }, true).maxNumeros).toBeNull();
    expect(resolverAcesso({ max_numeros: 3 }, true).maxNumeros).toBe(3);
  });
});

describe("cabeMaisUmNumero — o teto da empresa", () => {
  const com = (maxNumeros: number | null) => ({ embeddedSignup: true, coexistencia: true, maxNumeros });

  it("nulo = sem teto da empresa (vale só o plano)", () => {
    expect(cabeMaisUmNumero(com(null), 999)).toBe(true);
  });
  it("abaixo do teto cabe; no teto não cabe", () => {
    expect(cabeMaisUmNumero(com(3), 2)).toBe(true);
    expect(cabeMaisUmNumero(com(3), 3)).toBe(false);
  });
  it("zero é 'nenhum', e é diferente de nulo", () => {
    expect(cabeMaisUmNumero(com(0), 0)).toBe(false);
  });
});

describe("configuração pública do signup", () => {
  it("idDaMetaValido só aceita numérico", () => {
    expect(idDaMetaValido("1234567890123456")).toBe(true);
    expect(idDaMetaValido("12ab")).toBe(false);
    expect(idDaMetaValido("")).toBe(false);
    expect(idDaMetaValido(undefined)).toBe(false);
  });

  it("o .env só traz o app_id, e o config_id nunca vem dele", () => {
    expect(signupDoAmbiente({ META_APP_ID: "1234567890" })).toEqual({
      appId: "1234567890",
      configId: null,
      configIdCoexistencia: null,
      liberadoPorPadrao: false,
    });
    expect(signupDoAmbiente({ META_APP_ID: "não-é-número" }).appId).toBeNull();
  });

  it("a linha do banco vence, com o .env como piso do app_id", () => {
    const amb = signupDoAmbiente({ META_APP_ID: "1111111111" });
    expect(signupDaLinha({ app_id: null, signup_config_id: "2222222222" }, amb)).toMatchObject({
      appId: "1111111111",
      configId: "2222222222",
    });
    expect(signupDaLinha({ app_id: "3333333333" }, amb).appId).toBe("3333333333");
    // Valor ilegível no banco não vira config: cai para nulo.
    expect(signupDaLinha({ signup_config_id: "abc" }, amb).configId).toBeNull();
  });

  it("liberado_por_padrao só liga com `true` exato", () => {
    expect(signupDaLinha({ signup_liberado_por_padrao: true }).liberadoPorPadrao).toBe(true);
    expect(signupDaLinha({ signup_liberado_por_padrao: null }).liberadoPorPadrao).toBe(false);
  });
});

describe("gerarPinDoNumero", () => {
  it("sempre 6 dígitos, inclusive com zeros à esquerda", () => {
    for (let i = 0; i < 200; i++) expect(gerarPinDoNumero()).toMatch(/^[0-9]{6}$/);
  });
});
