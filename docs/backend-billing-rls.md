# Acesso RLS do backend ao faturamento

A migração `20261118140000_backend_billing_rls` acrescenta uma política
`backend_billing_runtime` a cada uma das nove tabelas de faturamento e uso:
`WorkspaceBilling`, `TrialRedemption`, `BillingCheckout`, `BillingSubscription`,
`BillingPayment`, `BillingEvent`, `BillingCommand`, `CommercialUsageBucket` e
`CommercialUsageReservation`.

Ela permite `SELECT/INSERT/UPDATE/DELETE` sob RLS **somente ao papel já existente
`pingchat_runtime`**, sujeito às ACLs DML existentes. Não cria papéis, logins,
memberships, grants, funções `SECURITY DEFINER`, permissões DDL ou `BYPASSRLS`;
não troca owners nem desativa RLS. Se o papel não existir, a migração é no-op.
Instalações próprias que criarem o papel depois precisam de nova mudança
operacional revisada; aplicar esta migração ausente o papel não provisiona acesso.

O worker atende legitimamente vários workspaces. Por isso a política do backend
usa `USING (true) WITH CHECK (true)`, e o isolamento entre clientes continua na
aplicação, nos loaders autenticados, nas FKs e nos snapshots imutáveis. Essa
política não deve ser atribuída a usuários ou papéis do navegador. Memberships
que permitam assumir/herdar `pingchat_runtime` também pertencem à fronteira de
confiança e precisam permanecer restritas ao backend.

Nenhuma política é criada para `PUBLIC`, `anon`, `authenticated` ou
`service_role`, e suas ACLs não são alteradas. Um papel que já tenha `BYPASSRLS`
(como o `service_role` padrão da Supabase) continua sujeito às ACLs existentes;
esta mudança não cria uma barreira contra superusers/owners/BYPASSRLS. Os papéis
negativos dos testes são NOLOGIN/NOBYPASSRLS aleatórios, sem alterar papéis
compartilhados. Eles recebem DML na fixture para provar que a política do backend
não autoriza outros papéis, mesmo quando há grants.

## Validação e aplicação

Antes de aplicar, conferir no ambiente alvo, sem exportar credenciais:

- Papel esperado existente, sem superuser, `BYPASSRLS`, criação de papéis/banco,
  ownership das nove tabelas ou memberships de API/browser.
- ACL DML do runtime já presente; nove tabelas com RLS e sem políticas permissivas
  para papéis públicos/API. O runtime não precisa de grants adicionais desta migração.
- Migrações anteriores e checksums correspondentes ao histórico aprovado.
- Revisões Claude/Codex e aprovação humana específica para o banco de produção.

A aplicação exige um operador owner autorizado, como a conexão administrativa
`postgres` da Supabase ou um workflow protegido com essa autorização. O papel
`pingchat_runtime` não possui DDL/ownership e não pode aplicar `CREATE POLICY`;
sua credencial serve apenas para validar o funcionamento do backend depois.
Aplicar o SQL exato revisado pelo fluxo aprovado com o owner autorizado.

Se o SQL for executado por `apply_migration` ou outro fluxo aprovado fora do
Prisma, a reconciliação oficial pelo comando abaixo é válida **somente após
comprovar a execução
integral do SQL exato, seu checksum e as nove policies resultantes**. Nunca marcar
como aplicada uma migração cujo SQL não foi executado, editar manualmente o
journal/checksums ou usar `db push`.

```sh
prisma migrate resolve --applied 20261118140000_backend_billing_rls
```

Verificar depois: nove policies `FOR ALL`, apenas `TO pingchat_runtime`, expressões
`true/true`, RLS e ACLs preservados; trial e quota pelo backend. Esta migração não
ativa `BILLING_ENABLED` nem comprova envio de e-mail, checkout ou cobrança Asaas.

A suíte `__tests__/billing-backend-rls.db.test.ts` executa os serviços reais em
PostgreSQL com `SET ROLE` via conexões Prisma, schemas isolados e roles NOLOGIN
únicos. Ela prova default-deny anterior, trial de 72 horas sem checkout/cartão,
ledger, limite de quota, inbox/outbox, negação dos outros papéis, imutabilidade e
restrições DDL. Apenas a constante literal do papel backend é substituída na
fixture. Nenhum SQL de produto é reescrito e nenhum token/API real é usado.

## Rollback sem perda de dados

Pausar novas vendas com `BILLING_SALES_ENABLED=false`, mantendo o enforcement
comercial ativo. Não desligar `BILLING_ENABLED` como rollback quando já houver
usuários ativos. Antes de retirar policies, avaliar o impacto na ingestão de
eventos financeiros, reconciliação e cancelamentos: o backend perderá acesso a
essas tabelas. A remoção exige aprovação humana específica e execução por um
operador que já seja owner autorizado.

Remover **somente** a política criada por esta migração nas nove tabelas. Não
remover tabelas, linhas, colunas, grants, papéis ou registros
`_prisma_migrations`; não desabilitar RLS.

SQL de rollback exclusivo do owner, sujeito à aprovação humana e nunca executado
automaticamente:

```sql
BEGIN;
DROP POLICY backend_billing_runtime ON public."WorkspaceBilling";
DROP POLICY backend_billing_runtime ON public."TrialRedemption";
DROP POLICY backend_billing_runtime ON public."BillingCheckout";
DROP POLICY backend_billing_runtime ON public."BillingSubscription";
DROP POLICY backend_billing_runtime ON public."BillingPayment";
DROP POLICY backend_billing_runtime ON public."BillingEvent";
DROP POLICY backend_billing_runtime ON public."BillingCommand";
DROP POLICY backend_billing_runtime ON public."CommercialUsageBucket";
DROP POLICY backend_billing_runtime ON public."CommercialUsageReservation";
COMMIT;
```

Isso restaura default-deny para o runtime nessas tabelas; dados e constraints
permanecem intactos. Não é um mecanismo de liberar quota nem reparar pagamentos.
Se o rollback for aplicado, reconciliar a alteração por nova migração revisada
antes de retomar a operação; não marcar a migração aplicada como pendente.

Referências primárias verificadas:
[PostgreSQL — Row Security Policies](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)
e [CREATE POLICY](https://www.postgresql.org/docs/current/sql-createpolicy.html).
