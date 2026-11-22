"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useT } from "@/hooks/i18n/useT";
import {
  useEmbeddedSignupConfig,
  useFinalizarEmbeddedSignup,
  type EmbeddedSignupConfig,
  type ModoDoSignup,
} from "@/hooks/channels/useEmbeddedSignup";
import { lerEventoDoSignup, origemEhDaMeta, type EventoDoSignup } from "@/lib/channels/meta/signup-evento";

/** O SDK de JavaScript do Facebook — o único jeito de abrir o Embedded Signup. */
const URL_DO_SDK = "https://connect.facebook.net/en_US/sdk.js";

interface RespostaDoLogin {
  authResponse?: { code?: string } | null;
  status?: string;
}

interface FbSdk {
  init(opcoes: { appId: string; autoLogAppEvents: boolean; xfbml: boolean; version: string }): void;
  login(
    callback: (resposta: RespostaDoLogin) => void,
    opcoes: {
      config_id: string;
      response_type: "code";
      override_default_response_type: true;
      extras: Record<string, unknown>;
    },
  ): void;
}

declare global {
  interface Window {
    FB?: FbSdk;
    fbAsyncInit?: () => void;
  }
}

/**
 * Carrega o SDK uma vez e inicializa com o app da instalação.
 *
 * `init` roda de novo se o `appId` mudar (a tela do admin pode ter trocado o app
 * entre duas visitas), mas o `<script>` nunca é duplicado.
 */
function useSdkDaMeta(appId: string | null, version: string): boolean {
  const [pronto, setPronto] = useState(false);

  useEffect(() => {
    if (!appId) return;
    const iniciar = () => {
      window.FB?.init({ appId, autoLogAppEvents: true, xfbml: true, version });
      setPronto(true);
    };
    if (window.FB) {
      iniciar();
      return;
    }
    window.fbAsyncInit = iniciar;
    if (!document.querySelector(`script[src="${URL_DO_SDK}"]`)) {
      const s = document.createElement("script");
      s.src = URL_DO_SDK;
      s.async = true;
      s.defer = true;
      s.crossOrigin = "anonymous";
      document.body.appendChild(s);
    }
  }, [appId, version]);

  return pronto;
}

/**
 * Conectar o número pela janela da Meta (Embedded Signup, #4074).
 *
 * ── O que a janela entrega, e em que ordem ──────────────────────────────────
 *
 * Dois sinais independentes: o callback do `FB.login` traz o `code` (vale 5
 * minutos, uso único) e a página recebe um `postMessage` com o `waba_id` e, fora da
 * coexistência, o `phone_number_id`. A ordem entre os dois NÃO é garantida, então o
 * cartão guarda cada um e só fecha a conexão quando tem os dois.
 *
 * ── Nada daqui é confiança ──────────────────────────────────────────────────
 *
 * O `postMessage` é um canal aberto: a origem é conferida (`origemEhDaMeta`) antes
 * de qualquer leitura, e o servidor só usa o `waba_id`/`phone_number_id` depois de
 * provar, com o token trocado do `code`, que o número é daquela conta. O token
 * nunca passa por este componente.
 */
export function EmbeddedSignupCard() {
  const t = useT();
  const { data, isPending } = useEmbeddedSignupConfig();
  const finalizar = useFinalizarEmbeddedSignup();
  const config: EmbeddedSignupConfig | undefined = data?.data;

  const sdkPronto = useSdkDaMeta(config?.appId ?? null, config?.graphVersion ?? "");
  const [aguardando, setAguardando] = useState<ModoDoSignup | null>(null);

  // Os dois sinais da janela, guardados até estarem completos.
  const codigo = useRef<string | null>(null);
  const evento = useRef<Extract<EventoDoSignup, { tipo: "concluido" }> | null>(null);
  const modoAtual = useRef<ModoDoSignup | null>(null);
  const jaEnviado = useRef(false);

  const reiniciar = useCallback(() => {
    codigo.current = null;
    evento.current = null;
    modoAtual.current = null;
    jaEnviado.current = false;
    setAguardando(null);
  }, []);

  const tentarFechar = useCallback(async () => {
    const ev = evento.current;
    const code = codigo.current;
    const modo = modoAtual.current;
    if (!ev || !code || !modo || jaEnviado.current) return;
    if (!ev.wabaId) {
      toast.error(t("A Meta não devolveu a conta do WhatsApp Business. Tente de novo."));
      reiniciar();
      return;
    }
    jaEnviado.current = true;
    try {
      const r = await finalizar.mutateAsync({
        code,
        waba_id: ev.wabaId,
        phone_number_id: ev.phoneNumberId,
        modo,
      });
      const c = r.data;
      toast.success(`${t("Conectado:")} ${c.displayName} ${c.phoneNumber ?? ""}`.trim());
      // O desfecho dos passos acessórios vai à tela: a conexão está de pé, mas o
      // operador precisa saber o que ficou pendente e por quê.
      if (c.registro && !c.registro.registrado) {
        toast.warning(`${t("Número conectado, mas o registro na Meta falhou:")} ${c.registro.erro ?? ""}`);
      }
      if (c.webhookRegistro && !c.webhookRegistro.registrado) {
        toast.warning(`${t("Webhook pendente:")} ${c.webhookRegistro.erro ?? ""}`);
      }
      if (c.sincronizacao && (c.sincronizacao.contatos.erro || c.sincronizacao.historico.erro)) {
        toast.warning(
          `${t("A sincronização do histórico não foi pedida:")} ${c.sincronizacao.contatos.erro ?? c.sincronizacao.historico.erro ?? ""}`,
        );
      }
    } catch {
      // `useFinalizarEmbeddedSignup` já mostra o erro da API (showApiError).
    } finally {
      reiniciar();
    }
  }, [finalizar, reiniciar, t]);

  // O canal de mensagens da janela. Registrado uma vez; lê a origem antes do dado.
  useEffect(() => {
    function aoReceber(e: MessageEvent) {
      if (!origemEhDaMeta(e.origin)) return;
      const lido = lerEventoDoSignup(e.data);
      if (!lido) return;
      if (lido.tipo === "concluido") {
        evento.current = lido;
        void tentarFechar();
      } else if (lido.tipo === "cancelado") {
        toast.message(t("Conexão cancelada na janela da Meta."));
        reiniciar();
      } else {
        toast.error(`${t("A Meta devolveu um erro:")} ${lido.mensagem ?? lido.codigo ?? ""}`.trim());
        reiniciar();
      }
    }
    window.addEventListener("message", aoReceber);
    return () => window.removeEventListener("message", aoReceber);
  }, [reiniciar, t, tentarFechar]);

  function abrir(modo: ModoDoSignup) {
    const m = config?.modos[modo];
    if (!m?.disponivel || !m.configId || !window.FB) return;
    reiniciar();
    modoAtual.current = modo;
    setAguardando(modo);
    window.FB.login(
      (resposta) => {
        const code = resposta.authResponse?.code;
        if (!code) {
          // Fechou a janela, ou negou a permissão.
          toast.message(t("A conexão não foi concluída na janela da Meta."));
          reiniciar();
          return;
        }
        codigo.current = code;
        void tentarFechar();
      },
      {
        config_id: m.configId,
        response_type: "code",
        override_default_response_type: true,
        extras: m.extras,
      },
    );
  }

  if (isPending) return null;
  // Sem app configurado a instalação não oferece esta porta, e dizer o motivo ao
  // admin de uma empresa seria expor configuração de servidor: a aba de token segue.
  if (!config || config.motivo === "meta_app_nao_configurado") return null;

  if (config.motivo === "signup_nao_liberado") {
    return (
      <Card className="p-4" data-testid="signup-nao-liberado">
        <h2 className="font-medium">{t("Conectar pela Meta")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("A conexão pela janela da Meta não está liberada para esta empresa. Fale com quem administra a instalação.")}
        </p>
      </Card>
    );
  }

  const { ativos, maxNumeros } = config.numeros;
  const noTeto = maxNumeros !== null && ativos !== null && ativos >= maxNumeros;
  const ocupado = aguardando !== null || finalizar.isPending;

  return (
    <Card className="flex flex-col gap-3 p-4" data-testid="signup-card">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-medium">{t("Conectar pela Meta")}</h2>
        {maxNumeros !== null ? (
          <Badge variant="outline" data-testid="signup-teto">
            {ativos ?? "—"} / {maxNumeros} {t("números")}
          </Badge>
        ) : null}
      </div>
      <p className="text-sm text-muted-foreground">
        {t("Abre a janela da Meta: você entra com o Facebook, escolhe o número e confirma. Nenhum token precisa ser copiado.")}
      </p>

      {noTeto ? (
        <p role="status" className="text-sm text-destructive" data-testid="signup-no-teto">
          {t("O limite de números oficiais desta empresa foi atingido. Peça a quem administra a instalação para ampliar o limite.")}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button
          data-testid="signup-numero-novo"
          disabled={!config.modos.numero_novo.disponivel || !sdkPronto || ocupado || noTeto}
          onClick={() => abrir("numero_novo")}
        >
          {aguardando === "numero_novo" ? t("Aguardando a Meta…") : t("Conectar um número novo")}
        </Button>
        {config.modos.coexistencia.disponivel ? (
          <Button
            variant="outline"
            data-testid="signup-coexistencia"
            disabled={!sdkPronto || ocupado || noTeto}
            onClick={() => abrir("coexistencia")}
          >
            {aguardando === "coexistencia" ? t("Aguardando a Meta…") : t("Usar o número que já está no app WhatsApp Business")}
          </Button>
        ) : null}
      </div>
      {config.modos.coexistencia.disponivel ? (
        <p className="text-xs text-muted-foreground">
          {t("Na coexistência o número continua no aplicativo WhatsApp Business do celular, e as conversas dos últimos meses são trazidas para o CRM.")}
        </p>
      ) : null}
    </Card>
  );
}
