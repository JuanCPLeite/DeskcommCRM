"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { updateMetaSignup, type UpdateMetaSignupResult } from "@/app/actions/settings/updateMetaSignup";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import { MENSAGEM_DA_RECUSA_DE_ESCRITA, ehRecusaDeEscrita } from "@/lib/auth/recusa-de-escrita-de-admin";

interface Props {
  /** Identificadores PÚBLICOS (vão ao navegador por desenho) — não há segredo aqui. */
  readonly appId: string;
  readonly configId: string;
  readonly configIdCoexistencia: string;
  readonly liberadoPorPadrao: boolean;
  /** O App Secret já foi cadastrado? Sem ele a troca do código não funciona. */
  readonly temSegredoSalvo: boolean;
  /** Leitura que falhou não pode virar "nunca configurado". */
  readonly leituraFalhou: boolean;
}

/** Os ids da Meta são numéricos; o mesmo formato que a ação valida no servidor. */
const FORMATO = /^[0-9]{5,30}$/;
const vazioOuValido = (v: string) => v.trim() === "" || FORMATO.test(v.trim());

export function FormularioDoSignupDaMeta(props: Props) {
  const t = useT();
  const router = useRouter();
  const [appId, setAppId] = useState(props.appId);
  const [configId, setConfigId] = useState(props.configId);
  const [configCoex, setConfigCoex] = useState(props.configIdCoexistencia);
  const [padrao, setPadrao] = useState(props.liberadoPorPadrao);
  const [ocupado, iniciar] = useTransition();

  const valido = vazioOuValido(appId) && vazioOuValido(configId) && vazioOuValido(configCoex);
  const mudou =
    appId.trim() !== props.appId ||
    configId.trim() !== props.configId ||
    configCoex.trim() !== props.configIdCoexistencia ||
    padrao !== props.liberadoPorPadrao;

  function motivoDaRecusa(r: Extract<UpdateMetaSignupResult, { ok: false }>): string {
    if (ehRecusaDeEscrita(r.error)) return t(MENSAGEM_DA_RECUSA_DE_ESCRITA[r.error]);
    if (r.error === "invalid_input") return t("Os identificadores da Meta são só números. Copie de novo do painel.");
    if (r.error === "nada_para_salvar") return t("Nada mudou.");
    return `${t("Não deu para salvar, e nada foi gravado.")} ${t(r.error)}`;
  }

  function salvar() {
    iniciar(async () => {
      const r = await updateMetaSignup({
        app_id: appId.trim(),
        signup_config_id: configId.trim(),
        signup_config_id_coexistencia: configCoex.trim(),
        signup_liberado_por_padrao: padrao,
      });
      if (!r.ok) {
        toast.error(motivoDaRecusa(r));
        return;
      }
      toast.success(t("Configuração do Embedded Signup salva."));
      router.refresh();
    });
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 px-6 pb-10">
      <header>
        <h2 className="text-xl font-semibold tracking-tight">{t("Conexão pela Meta (Embedded Signup)")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("Com o app de Tech Provider desta instalação, cada empresa conecta o próprio número numa janela da Meta, sem copiar token. Estes identificadores aparecem no painel do seu app.")}
        </p>
      </header>

      {props.leituraFalhou ? (
        <p role="alert" className="rounded-md border border-warning/40 bg-warning-bg p-3 text-xs leading-4 text-text-muted">
          {t("Não deu para ler a configuração salva agora, então o que aparece abaixo pode não ser o que está valendo. Recarregue a página antes de trocar qualquer coisa.")}
        </p>
      ) : null}

      {!props.temSegredoSalvo ? (
        <p data-testid="signup-sem-segredo" className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
          {t("Cadastre primeiro a chave secreta do aplicativo, acima. Sem ela o sistema não consegue concluir a conexão do cliente.")}
        </p>
      ) : null}

      <Card className="flex flex-col gap-4 p-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="meta-app-id">{t("ID do aplicativo (App ID)")}</Label>
          <Input
            id="meta-app-id"
            data-testid="meta-app-id"
            inputMode="numeric"
            autoComplete="off"
            value={appId}
            onChange={(e) => setAppId(e.target.value)}
            placeholder="1234567890123456"
          />
          <p className="text-xs text-muted-foreground">
            {t("Painel da Meta › Configurações do app › Básico. Não é segredo: o navegador precisa dele para abrir a janela.")}
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="meta-config-id">{t("ID da configuração — número novo")}</Label>
          <Input
            id="meta-config-id"
            data-testid="meta-config-id"
            inputMode="numeric"
            autoComplete="off"
            value={configId}
            onChange={(e) => setConfigId(e.target.value)}
            placeholder="1234567890123456"
          />
          <p className="text-xs text-muted-foreground">
            {t("Criada em Login do Facebook para Empresas › Configurações, com o produto WhatsApp Embedded Signup.")}
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="meta-config-id-coex">{t("ID da configuração — coexistência (opcional)")}</Label>
          <Input
            id="meta-config-id-coex"
            data-testid="meta-config-id-coex"
            inputMode="numeric"
            autoComplete="off"
            value={configCoex}
            onChange={(e) => setConfigCoex(e.target.value)}
            placeholder={t("Em branco = usa a configuração de número novo")}
          />
          <p className="text-xs text-muted-foreground">
            {t("Coexistência é o cliente manter o número no aplicativo WhatsApp Business enquanto o CRM também o usa.")}
          </p>
        </div>

        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            data-testid="meta-liberado-por-padrao"
            className="mt-1"
            checked={padrao}
            onChange={(e) => setPadrao(e.target.checked)}
          />
          <span>
            <span className="font-medium">{t("Liberar para todas as empresas por padrão")}</span>
            <span className="block text-xs text-muted-foreground">
              {t("Desligado, só abre para a empresa que você liberar em Empresas › API Oficial. Ligado, vale para todas, exceto as que você bloquear.")}
            </span>
          </span>
        </label>

        <div className="flex items-center justify-end">
          <Button data-testid="meta-signup-salvar" disabled={!valido || !mudou || ocupado} onClick={salvar}>
            {ocupado ? t("Salvando…") : t("Salvar")}
          </Button>
        </div>
        {!valido ? (
          <p role="alert" className="text-xs text-destructive">
            {t("Os identificadores da Meta são só números.")}
          </p>
        ) : null}
      </Card>
    </div>
  );
}
