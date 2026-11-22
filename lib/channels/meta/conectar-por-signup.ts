/**
 * Conectar um número oficial pela janela da Meta (Embedded Signup, #4074): o caso de
 * uso inteiro, do `code` do navegador até o número recebendo mensagem.
 *
 * A rota fala HTTP; quem decide a ordem — e por que ela é essa — é este arquivo.
 *
 * ─── A ordem é a ordem em que dá errado ─────────────────────────────────────
 *
 *   1. ACESSO da empresa (Embedded Signup e coexistência liberados?) ANTES de
 *      qualquer chamada à Meta — recusa sem gastar o `code`. O TETO de números não
 *      cabe aqui: reconectar um número que a empresa já tem NÃO ocupa vaga, e só se
 *      sabe qual número é depois da troca (na coexistência o evento nem o traz). A
 *      tela já impede abrir a janela quando a empresa está no teto
 *      (`GET /embedded-signup` devolve `numeros`), e o servidor reconfere no passo 4,
 *      que é onde a resposta é certa;
 *   2. o `code` é trocado SEM demora: ele vale 5 minutos e é de uso único;
 *   3. o número é PROVADO contra a WABA com o token trocado. O `waba_id` e o
 *      `phone_number_id` do navegador são informação do navegador, não confiança;
 *   4. a sessão é gravada ANTES de qualquer passo de pós-conexão (webhook, registro,
 *      sincronização): se um deles falhar a conexão continua de pé e o desfecho vai
 *      para a tela — desfazer um canal por causa de um passo acessório trocaria um
 *      problema por dois (mesma decisão de `webhook-da-sessao.ts`);
 *   5. o PIN e a marca de coexistência vão para tabela SÓ DO SERVIDOR
 *      (`channel_session_meta_signup`), nunca para colunas de `channel_sessions`.
 *
 * ─── Isolamento entre empresas ──────────────────────────────────────────────
 *
 * `organizationId` vem de `requireRole` (sessão validada), jamais do corpo. O
 * client é service role e bypassa RLS, então TODA consulta a `channel_sessions`
 * filtra `organization_id` — a varredura `canal-consulta-por-organizacao.test.ts`
 * reprova a que esquecer.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ARCHIVED_AT, queryTolerantToMissingArchived } from "@/lib/channels/archived";
import { CHANNEL_PROVIDER_META } from "@/lib/channels/capabilities";
import { reactivateChannelSession } from "@/lib/channels/reactivate";
import { metadataInicialDoCanal } from "@/lib/ai/elegibilidade/pre-go-live";
import { traduzirLimiteDoPlano } from "@/lib/cobranca/limites";
import type { Idioma } from "@/lib/i18n/idiomas";
import { logger } from "@/lib/logger";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";

import { ACESSO_FECHADO, MENSAGEM_DO_TETO_DA_EMPRESA, acessoDaEmpresa, cabeMaisUmNumero } from "./acesso-da-empresa";
import { appDaMeta } from "./app";
import {
  descobrirNumerosDaWaba,
  descobrirWabasDoToken,
  gerarPinDoNumero,
  registrarNumeroNaCloudApi,
  sincronizarCoexistencia,
  trocarCodigoPorToken,
  type DesfechoSimples,
  type ModoDoSignup,
} from "./embedded-signup";
import {
  ORIGEM_DO_EMBEDDED_SIGNUP,
  ROTULOS_DA_ORIGEM,
  registrarOrigemDaConexao,
} from "./origem-da-conexao";
import { contarNumerosAtivos } from "./numeros-da-empresa";
import { idDaMetaValido, signupDaMeta } from "./signup-config";
import { validateMetaCredentials } from "./validate-credentials";
import { registrarWebhookDaSessao, type DesfechoDoWebhookDaSessao } from "./webhook-da-sessao";

export interface EntradaDoSignup {
  readonly admin: SupabaseClient;
  readonly organizationId: string;
  readonly userId: string;
  readonly idioma: Idioma;
  readonly requestId: string;
  /** Base pública do webhook (`basePublicaDoWebhookMeta(req)`). */
  readonly base: string;
  readonly code: string;
  /**
   * Pode faltar: o evento `FINISH` real da Meta (medido em 22/11/2026) vem SEM
   * `waba_id`. Aí o servidor descobre a conta pelo token (`debug_token`) e prova que o
   * número é dela.
   */
  readonly wabaId: string | null;
  /** Pode faltar (coexistência). Aí o servidor descobre pela WABA. */
  readonly phoneNumberId: string | null;
  readonly modo: ModoDoSignup;
}

export type FalhaDoSignup = {
  readonly ok: false;
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly details?: unknown;
};

export interface ConexaoDoSignup {
  readonly ok: true;
  readonly channelSessionId: string;
  readonly displayName: string;
  readonly phoneNumber: string | null;
  readonly modo: ModoDoSignup;
  readonly origem: { readonly valor: "embedded_signup"; readonly rotulo: string };
  /** `false` não desfaz a conexão: o canal envia; falta a entrega. */
  readonly webhookRegistro: DesfechoDoWebhookDaSessao | null;
  /** Só em número novo. `ok: false` = o número não está registrado na Cloud API. */
  readonly registro: DesfechoSimples | null;
  /** Só em coexistência. Cada pedido só pode ser feito uma vez, e a Meta dá 24 h. */
  readonly sincronizacao: { readonly contatos: DesfechoSimples; readonly historico: DesfechoSimples } | null;
}

function falha(status: number, code: string, message: string, details?: unknown): FalhaDoSignup {
  return { ok: false, status, code, message, ...(details !== undefined ? { details } : {}) };
}

interface SessaoExistente {
  id: string;
  archived_at?: string | null;
  webhook_path_token?: string | null;
  display_name?: string | null;
}

export async function conectarPeloSignup(
  entrada: EntradaDoSignup,
): Promise<ConexaoDoSignup | FalhaDoSignup> {
  const { admin, organizationId, userId, requestId, modo } = entrada;

  if (entrada.wabaId !== null && !idDaMetaValido(entrada.wabaId)) {
    return falha(422, "invalid_request", "O identificador da conta do WhatsApp Business veio em formato inválido.");
  }
  if (entrada.wabaId === null && entrada.phoneNumberId === null) {
    return falha(422, "invalid_request", "A Meta não devolveu a conta nem o número. Refaça a conexão.");
  }
  if (entrada.phoneNumberId !== null && !idDaMetaValido(entrada.phoneNumberId)) {
    return falha(422, "invalid_request", "O identificador do número veio em formato inválido.");
  }

  // ── 1. A instalação tem o app, e a empresa foi liberada ───────────────────
  const [signup, app, acesso] = await Promise.all([
    signupDaMeta(),
    appDaMeta(),
    acessoDaEmpresa(organizationId),
  ]);
  if (!signup.appId || !app.appSecret) {
    return falha(
      409,
      "meta_app_nao_configurado",
      "O app da Meta desta instalação ainda não está configurado. Quem administra a instalação cadastra em Admin › API Oficial (Meta).",
    );
  }
  if (acesso === ACESSO_FECHADO || !acesso.embeddedSignup) {
    return falha(403, "signup_nao_liberado", "A conexão pela Meta não está liberada para esta empresa.");
  }
  if (modo === "coexistencia" && !acesso.coexistencia) {
    return falha(403, "coexistencia_nao_liberada", "A coexistência com o app WhatsApp Business não está liberada para esta empresa.");
  }

  // ── 2. O código, sem demora ───────────────────────────────────────────────
  const troca = await trocarCodigoPorToken({
    appId: signup.appId,
    appSecret: app.appSecret,
    code: entrada.code,
  });
  if (!troca.ok) {
    return falha(
      422,
      "troca_do_codigo_recusada",
      `A Meta recusou o código do cadastro: ${troca.motivo}. O código vale só 5 minutos — refaça a conexão.`,
    );
  }
  const token = troca.accessToken;

  // ── 3. Qual conta? Qual número? E ele é daquela conta? ────────────────────
  let wabaId = entrada.wabaId;
  if (wabaId === null) {
    // O evento da janela veio sem `waba_id`: as contas autorizadas saem do token, e a
    // dona do número é a que o lista. Número que NENHUMA delas lista não se conecta.
    const wabas = await descobrirWabasDoToken({ appId: signup.appId, appSecret: app.appSecret, token });
    if (!wabas.ok) {
      return falha(422, "waba_nao_encontrada", `Não deu para descobrir a conta do WhatsApp Business: ${wabas.motivo}.`);
    }
    if (wabas.wabaIds.length === 0) {
      return falha(422, "waba_nao_encontrada", "A Meta não liberou nenhuma conta do WhatsApp Business para este cadastro. Refaça a conexão.");
    }
    const dona: string[] = [];
    for (const candidata of wabas.wabaIds) {
      const lista = await descobrirNumerosDaWaba({ wabaId: candidata, token });
      if (!lista.ok) continue;
      const acho = entrada.phoneNumberId
        ? lista.numeros.some((n) => n.id === entrada.phoneNumberId)
        : lista.numeros.length === 1;
      if (acho) dona.push(candidata);
    }
    if (dona.length !== 1) {
      // Zero ou mais de uma: não se adivinha, porque conectar a conta errada põe a
      // mensagem de um cliente no inbox de outro.
      return falha(
        409,
        "waba_ambigua",
        dona.length === 0
          ? "Não achei, nas contas liberadas pela Meta, a dona deste número. Refaça a conexão."
          : "Mais de uma conta liberada contém este número, e não dá para saber qual usar. Use a aba de token.",
      );
    }
    wabaId = dona[0]!;
  }

  let phoneNumberId = entrada.phoneNumberId;
  if (!phoneNumberId) {
    const achados = await descobrirNumerosDaWaba({ wabaId, token });
    if (!achados.ok) {
      return falha(422, "numero_nao_encontrado", `Não deu para descobrir o número da conta: ${achados.motivo}.`);
    }
    if (achados.numeros.length !== 1) {
      // Ambíguo não se adivinha: conectar o número errado põe mensagem de um
      // cliente no inbox de outro.
      return falha(
        409,
        "varios_numeros_na_conta",
        achados.numeros.length === 0
          ? "A conta ainda não tem nenhum número. Conclua o cadastro na Meta e tente de novo."
          : "A conta tem mais de um número, e não dá para saber qual conectar. Use a aba de token para escolher o número.",
      );
    }
    phoneNumberId = achados.numeros[0]!.id;
  }

  const validacao = await validateMetaCredentials({ phoneNumberId, token, wabaId });
  if (!validacao.ok) {
    return falha(422, "invalid_request", validacao.motivo);
  }

  // ── 4. O número já é desta empresa? Se não, cabe mais um? ─────────────────
  const buscar = (colunas: string) =>
    admin
      .from("channel_sessions")
      .select(colunas)
      .eq("organization_id", organizationId)
      .eq("provider", CHANNEL_PROVIDER_META)
      .eq("meta_phone_number_id", phoneNumberId)
      .maybeSingle();
  const { data: existenteRaw, error: erroDaBusca } = await queryTolerantToMissingArchived(
    () => buscar(`id, ${ARCHIVED_AT}, webhook_path_token, display_name`),
    () => buscar("id, webhook_path_token, display_name"),
  );
  if (erroDaBusca) {
    logger.warn("[meta.signup] busca da sessão existente falhou", { requestId });
    return falha(500, "internal_error", "Não deu para conferir se o número já está conectado. Tente de novo.");
  }
  const existente = existenteRaw as SessaoExistente | null;

  if (!existente || existente.archived_at) {
    // Nova conexão (ou ressurreição): ocupa uma vaga.
    const ativos = await contarNumerosAtivos(admin, organizationId);
    if (ativos === null) {
      return falha(500, "internal_error", "Não deu para contar os números conectados. Tente de novo.");
    }
    if (!cabeMaisUmNumero(acesso, ativos)) {
      return falha(409, "limite_da_empresa", MENSAGEM_DO_TETO_DA_EMPRESA, { ativos, max_numeros: acesso.maxNumeros });
    }
  }

  // ── 5. Cifra, e grava ─────────────────────────────────────────────────────
  const cifrado = await encryptWebhookSecret(admin, token);
  if (!cifrado) {
    // Sem a cifra, gravar o token em claro seria pior que recusar.
    return falha(
      422,
      "cifra_indisponivel",
      "cifra indisponível nesta instalação (GUC app.nuvemshop_oauth_key ausente) — o token não foi gravado",
    );
  }

  const linha = {
    organization_id: organizationId,
    provider: CHANNEL_PROVIDER_META,
    meta_phone_number_id: phoneNumberId,
    meta_waba_id: wabaId,
    meta_token_encrypted: cifrado,
    phone_number: validacao.displayPhoneNumber ? `+${validacao.displayPhoneNumber.replace(/\D/g, "")}` : null,
    display_name: existente?.display_name || (validacao.verifiedName ?? "Canal oficial"),
    status: "WORKING",
  };

  let channelSessionId: string | null = existente?.id ?? null;
  let webhookPathToken: string | null = existente?.webhook_path_token ?? null;
  let erroDeGravacao: { message?: string | null; code?: string | null } | null = null;

  if (existente) {
    ({ error: erroDeGravacao } = await reactivateChannelSession(
      admin,
      { organizationId, channelSessionId: existente.id, archivedAt: existente.archived_at ?? null },
      linha,
      { userId, requestId, metadata: { provider: CHANNEL_PROVIDER_META, phone_number: linha.phone_number } },
    ));
  } else {
    const inserida = await admin
      .from("channel_sessions")
      .insert({ ...linha, webhook_secret_encrypted: cifrado, metadata: metadataInicialDoCanal() })
      .select("id, webhook_path_token")
      .maybeSingle();
    erroDeGravacao = inserida.error;
    channelSessionId = inserida.data?.id ?? null;
    webhookPathToken = inserida.data?.webhook_path_token ?? null;
  }

  if (erroDeGravacao) {
    const limite = traduzirLimiteDoPlano(erroDeGravacao, entrada.idioma);
    if (limite) return falha(409, limite.code, limite.message, limite.details);
    // O índice parcial da 0165: o número já está ATIVO em outra empresa.
    if (erroDeGravacao.code === "23505") {
      return falha(409, "numero_em_uso", "Este número já está conectado em outra empresa desta instalação.");
    }
    logger.warn("[meta.signup] gravação da sessão falhou", { requestId, codigo: erroDeGravacao.code ?? null });
    return falha(500, "internal_error", erroDeGravacao.message ?? "channel_session_write_failed");
  }
  if (!channelSessionId) {
    return falha(500, "internal_error", "channel_session_write_failed");
  }

  // ── 6. Pós-conexão: nada daqui desfaz a conexão ───────────────────────────
  await registrarOrigemDaConexao(admin, {
    organizationId,
    channelSessionId,
    origem: ORIGEM_DO_EMBEDDED_SIGNUP,
  });

  let registro: DesfechoSimples | null = null;
  let pinCifrado: string | null = null;
  if (modo === "numero_novo") {
    // Só número novo se registra. Na coexistência o número JÁ está registrado no
    // app WhatsApp Business, e registrá-lo de novo é fora do contrato da Meta.
    const pin = gerarPinDoNumero();
    registro = await registrarNumeroNaCloudApi({ phoneNumberId, token, pin });
    if (registro.ok) pinCifrado = await encryptWebhookSecret(admin, pin);
  }

  let sincronizacao: ConexaoDoSignup["sincronizacao"] = null;
  if (modo === "coexistencia") {
    sincronizacao = await sincronizarCoexistencia({ phoneNumberId, token });
  }

  const agora = new Date().toISOString();
  const estado = await admin.from("channel_session_meta_signup").upsert(
    {
      channel_session_id: channelSessionId,
      organization_id: organizationId,
      coexistencia: modo === "coexistencia",
      pin_encrypted: pinCifrado,
      contatos_pedidos_em: sincronizacao?.contatos.ok ? agora : null,
      historico_pedido_em: sincronizacao?.historico.ok ? agora : null,
      sincronizacao_erro: sincronizacao
        ? [
            sincronizacao.contatos.ok ? null : `contatos: ${sincronizacao.contatos.motivo}`,
            sincronizacao.historico.ok ? null : `historico: ${sincronizacao.historico.motivo}`,
          ]
            .filter(Boolean)
            .join("; ") || null
        : null,
    },
    { onConflict: "channel_session_id" },
  );
  if (estado.error) {
    // Banco anterior à 9452, ou falha passageira: a conexão segue, e dizemos.
    logger.warn("[meta.signup] estado do signup não foi gravado", {
      requestId,
      codigo: (estado.error as { code?: string }).code ?? null,
    });
  }

  const webhookRegistro = webhookPathToken
    ? await registrarWebhookDaSessao({
        admin: admin as Parameters<typeof registrarWebhookDaSessao>[0]["admin"],
        channelSessionId,
        phoneNumberId,
        wabaId,
        tokenCifrado: cifrado,
        webhookPathToken,
        base: entrada.base,
        requestId,
      })
    : null;

  return {
    ok: true,
    channelSessionId,
    displayName: linha.display_name,
    phoneNumber: linha.phone_number,
    modo,
    origem: { valor: "embedded_signup", rotulo: ROTULOS_DA_ORIGEM.embedded_signup },
    webhookRegistro,
    registro,
    sincronizacao,
  };
}
