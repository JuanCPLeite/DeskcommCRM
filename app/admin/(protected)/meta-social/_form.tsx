"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import {
  rotacionarVerifyTokenDoAppSocial,
  updateMetaSocialApp,
  type UpdateMetaSocialAppResult,
} from "@/app/actions/settings/updateMetaSocialApp";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import { MENSAGEM_DA_RECUSA_DE_ESCRITA, ehRecusaDeEscrita } from "@/lib/auth/recusa-de-escrita-de-admin";
import { copyToClipboard } from "@/lib/clipboard";

interface Props {
  readonly appIdInicial: string;
  readonly loginConfigIdInicial: string;
  /** SE existe chave gravada — nunca QUAL, nem cifrada. */
  readonly temSegredoSalvo: boolean;
  /** SE existe token gravado. O valor não tem leitura: sai só da ação que o gera. */
  readonly temTokenSalvo: boolean;
  readonly tokenGeradoEm: string | null;
  readonly atualizadoEm: string | null;
  /** O par está no `.env` desta instalação (o piso de rollback). */
  readonly temNoAmbiente: boolean;
  readonly leituraFalhou: boolean;
  readonly urlDoWebhook: string;
  readonly urlDeRedirecionamento: string;
}

/** O piso do schema da ação. Abaixo disso o Zod recusa e a tela culparia o dono. */
const TAMANHO_MINIMO_DA_CHAVE = 16;

export function FormularioDoAppSocial({
  appIdInicial,
  loginConfigIdInicial,
  temSegredoSalvo,
  temTokenSalvo,
  tokenGeradoEm,
  atualizadoEm,
  temNoAmbiente,
  leituraFalhou,
  urlDoWebhook,
  urlDeRedirecionamento,
}: Props) {
  const t = useT();
  const router = useRouter();
  const [appId, setAppId] = useState(appIdInicial);
  const [loginConfigId, setLoginConfigId] = useState(loginConfigIdInicial);
  const [chave, setChave] = useState("");
  // O token recém-gerado vive SÓ na memória desta aba: recarregar o perde, e é o desenho.
  const [tokenNovo, setTokenNovo] = useState<string | null>(null);
  const [confirmandoTroca, setConfirmandoTroca] = useState(false);
  const [ocupado, iniciar] = useTransition();

  const chaveValida = chave.trim() === "" || chave.trim().length >= TAMANHO_MINIMO_DA_CHAVE;
  const mudouIds = appId.trim() !== appIdInicial || loginConfigId.trim() !== loginConfigIdInicial;
  const podeSalvar = chaveValida && (chave.trim() !== "" || mudouIds);

  function motivoDaRecusa(r: Extract<UpdateMetaSocialAppResult, { ok: false }>): string {
    if (ehRecusaDeEscrita(r.error)) return t(MENSAGEM_DA_RECUSA_DE_ESCRITA[r.error]);
    switch (r.error) {
      case "invalid_input":
        return t("A chave parece incompleta. Copie de novo do painel da Meta — ela tem 32 caracteres.");
      case "app_secret_obrigatorio":
        return t("Cadastre a chave secreta do aplicativo primeiro. Sem ela o token não vale.");
      case "nada_para_salvar":
        return t("Nada mudou. Digite uma chave nova para substituir a atual.");
      case "leitura_do_app_falhou":
        return t("Não consegui conferir o que já está gravado, então nada foi alterado. Tente de novo em instantes.");
      default:
        return `${t("Não deu para salvar, e nada foi gravado.")} ${t(r.error)}`;
    }
  }

  function aoGravar(r: UpdateMetaSocialAppResult, sucesso: string) {
    if (!r.ok) {
      toast.error(motivoDaRecusa(r));
      return;
    }
    if (r.verifyToken) setTokenNovo(r.verifyToken);
    toast.success(sucesso);
    router.refresh();
  }

  function salvar() {
    iniciar(async () => {
      const r = await updateMetaSocialApp({
        appId: appId.trim(),
        loginConfigId: loginConfigId.trim(),
        ...(chave.trim() ? { appSecret: chave.trim() } : {}),
      });
      if (r.ok) setChave("");
      aoGravar(r, t("Configuração salva."));
    });
  }

  function gerarToken() {
    setConfirmandoTroca(false);
    iniciar(async () => {
      aoGravar(await rotacionarVerifyTokenDoAppSocial(), t("Token de verificação gerado."));
    });
  }

  async function copiar(valor: string) {
    if (await copyToClipboard(valor)) toast.success(t("Copiado."));
    else toast.error(t("Não deu para copiar. Selecione o texto e copie à mão."));
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t("Instagram e Facebook da Meta desta instalação")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("Credenciais do app Meta que conecta as contas do Instagram e do Facebook pelo login unificado. Elas valem para a instalação inteira — cada empresa conecta as próprias contas depois, em Conexões.")}
        </p>
      </header>

      {leituraFalhou ? (
        <p role="alert" className="rounded-md border border-warning/40 bg-warning-bg p-3 text-xs leading-4 text-text-muted">
          {t("Não deu para ler a configuração salva agora, então o que aparece abaixo pode não ser o que está valendo. Recarregue a página antes de trocar qualquer coisa.")}
        </p>
      ) : null}

      <Card className="flex flex-col gap-4 p-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="meta-social-app-id">{t("ID do app")}</Label>
          <Input
            id="meta-social-app-id"
            data-testid="meta-social-app-id"
            autoComplete="off"
            value={appId}
            onChange={(e) => setAppId(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">{t("Fica no painel da Meta, em Configurações do app › Básico.")}</p>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="meta-social-config-id">{t("ID da configuração do login")}</Label>
          <Input
            id="meta-social-config-id"
            data-testid="meta-social-config-id"
            autoComplete="off"
            value={loginConfigId}
            onChange={(e) => setLoginConfigId(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            {t("Login unificado: fica em Login do Facebook para Empresas › Configurações. Login do Instagram (app com a aba “Login empresarial no Instagram”): deixe em branco e use, acima, o ID do app do Instagram.")}
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="meta-social-app-secret">{t("Chave secreta do aplicativo")}</Label>
          <Input
            id="meta-social-app-secret"
            data-testid="meta-social-app-secret"
            type="password"
            autoComplete="off"
            value={chave}
            onChange={(e) => setChave(e.target.value)}
            placeholder={temSegredoSalvo ? t("••••••••  (já cadastrada)") : t("32 letras e números")}
          />
          <p className="text-xs text-muted-foreground">
            {temSegredoSalvo
              ? t("Já existe uma chave cadastrada. Deixe em branco para mantê-la, ou digite uma nova para substituir.")
              : t("Fica no painel da Meta, em Configurações do app › Básico. Ela é guardada cifrada e nunca volta a aparecer nesta tela.")}
          </p>
        </div>

        {temNoAmbiente ? (
          <p data-testid="meta-social-tem-no-ambiente" className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
            {t("Esta instalação já tem a chave e o token no arquivo de configuração do servidor. O que você salvar aqui passa a valer no lugar deles — e, a partir daí, é o token desta tela que precisa estar colado no painel da Meta.")}
          </p>
        ) : null}

        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-muted-foreground">
            {atualizadoEm ? `${t("Última alteração em")} ${atualizadoEm}.` : t("Nunca configurado por aqui.")}
          </span>
          <Button data-testid="meta-social-salvar" disabled={!podeSalvar || ocupado} onClick={salvar}>
            {ocupado ? t("Salvando…") : t("Salvar")}
          </Button>
        </div>
      </Card>

      <Card className="flex flex-col gap-4 p-4">
        <div className="flex flex-col gap-1">
          <h2 className="font-medium">{t("Token de verificação")}</h2>
          <p className="text-sm text-muted-foreground" data-testid="meta-social-token-estado">
            {temTokenSalvo && tokenGeradoEm
              ? `${t("Gerado em")} ${tokenGeradoEm}.`
              : temTokenSalvo
                ? t("Já existe um token gerado.")
                : t("Ainda não existe. Ele é criado pelo sistema na primeira vez que você salva a chave secreta — ninguém precisa inventar nada.")}
          </p>
        </div>

        {tokenNovo ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="meta-social-token-gerado">{t("Seu token de verificação")}</Label>
            <div className="flex items-center gap-2">
              <Input
                id="meta-social-token-gerado"
                data-testid="meta-social-token-gerado"
                readOnly
                value={tokenNovo}
                className="font-mono text-xs"
                onFocus={(e) => e.currentTarget.select()}
              />
              <Button variant="outline" data-testid="meta-social-copiar-token" onClick={() => void copiar(tokenNovo)}>
                {t("Copiar")}
              </Button>
            </div>
            <p className="rounded-md border border-warning/40 bg-warning-bg p-3 text-xs leading-4 text-text-muted">
              <strong className="font-semibold text-text">{t("Copie agora.")}</strong>{" "}
              {t("Por segurança, ele não aparece de novo depois que você sair desta página. Se perder, é só gerar outro aqui.")}
            </p>
          </div>
        ) : null}

        {temSegredoSalvo ? (
          <div className="flex justify-end">
            <Button
              variant="outline"
              data-testid="meta-social-gerar-token"
              disabled={ocupado}
              onClick={() => (temTokenSalvo ? setConfirmandoTroca(true) : gerarToken())}
            >
              {temTokenSalvo ? t("Gerar novo token") : t("Gerar token")}
            </Button>
          </div>
        ) : null}
      </Card>

      <Card className="flex flex-col gap-3 p-4">
        <h2 className="font-medium">{t("Endereços para colar no painel da Meta")}</h2>
        {(
          [
            [t("URL de callback do webhook"), urlDoWebhook, "webhook"],
            [t("URI de redirecionamento do OAuth"), urlDeRedirecionamento, "redirect"],
          ] as const
        ).map(([rotulo, valor, id]) => (
          <div key={id} className="flex flex-col gap-1.5">
            <Label>{rotulo}</Label>
            <div className="flex items-center gap-2">
              <Input readOnly value={valor} data-testid={`meta-social-url-${id}`} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
              <Button variant="outline" onClick={() => void copiar(valor)}>
                {t("Copiar")}
              </Button>
            </div>
          </div>
        ))}
        <p className="text-xs text-muted-foreground">
          {t("No painel da Meta, em Webhooks › Instagram, o token de verificação vai no campo “Verificar token” e a URL de callback é a de cima. O URI de redirecionamento vai em Login do Facebook para Empresas › Configurações e na configuração do login do Instagram.")}
        </p>
      </Card>

      <AlertDialog open={confirmandoTroca} onOpenChange={setConfirmandoTroca}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Gerar um novo token de verificação?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("O token atual deixa de valer na hora. As mensagens que já chegam continuam chegando, porque elas são conferidas pela chave secreta. O que muda: a Meta só consegue confirmar o endereço do webhook de novo depois que você colar o token novo no painel dela.")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
            <AlertDialogAction data-testid="meta-social-confirmar-novo-token" onClick={gerarToken}>
              {t("Gerar novo token")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
