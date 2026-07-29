begin;

-- 規約同意・会員登録が済む前に届いた質問を一時的に預かる。
-- 登録完了後に自動で回答へ回すことで、利用者が同じ質問を打ち直す必要をなくす。
create table if not exists pending_questions (
  line_user_id text primary key,
  question text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours')
);

create index if not exists pending_questions_expires_at_idx
  on pending_questions (expires_at);

alter table pending_questions enable row level security;

-- No browser policies are added. Access is restricted to the server-only DB role.

commit;
