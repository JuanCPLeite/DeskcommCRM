---
impacto: capacidade_nova
secao: adicionado
titulo: Avisos quase em tempo real na Central quando o número oficial cai de qualidade ou o modelo muda de qualidade ou categoria, e seletor de número em Modelos
---

Antes, o CRM só sabia do status de revisão do modelo e, de 5 em 5 minutos, de número
fora do ar. A Meta também avisa, em segundos, quando o **número** sobe ou cai de
qualidade ou de limite de envio, quando a **qualidade de um modelo** muda e quando ela
**recategoriza um modelo** (utilidade ↔ marketing, que muda o preço por mensagem).

Agora esses três eventos viram avisos na **Central**, com gravidade (número sinalizado
e modelo em qualidade baixa são críticos; modelo que virou marketing é atenção) e sem
repetir o mesmo aviso. A categoria e a qualidade do modelo também são atualizadas na
lista de **Conexões › Modelos**.

Também nesta entrega:

- **Conexões › API Oficial.** Com o Embedded Signup liberado para a empresa, o
  formulário de token manual deixa de aparecer; fica atrás do botão "Avançado".
- **Conexões › Modelos.** Com mais de um número oficial, aparece um seletor de número.
  Os modelos pertencem à conta do WhatsApp Business, não ao número: números da mesma
  conta compartilham a lista, e a tela avisa disso.

**Ação do operador:** no painel da Meta, em Webhooks do app, assine os campos
`phone_number_quality_update`, `message_template_quality_update` e
`template_category_update`. Sem a assinatura, nenhum aviso novo chega. Em
conexões novas o CRM já pede esses campos; as existentes precisam da assinatura manual.

Sem migration: os avisos reaproveitam tipos de aviso que já existem na Central.
