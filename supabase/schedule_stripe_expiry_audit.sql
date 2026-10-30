-- Schedule ONLY after deploying and smoke-testing reconcile-checkout-expiry.
-- First create a Vault secret named street_face_expiry_cron_token containing
-- the SAME randomly-generated token as Edge Function secret RECONCILIATION_CRON_TOKEN.
-- Do not put the token in this file, Git, or the chat.
--
-- A token can be generated in Terminal with: openssl rand -hex 32
-- Create the Vault secret in the Supabase Vault dashboard.
--
-- The Edge Function defaults to dry-run; to reconcile confirmed expiries,
-- set Edge Function secret EXPIRY_RECONCILIATION_APPLY=true after verification.
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

-- Refuse to schedule an unauthenticated task when Vault is not ready.
do $$
begin
  if (select count(*) from vault.decrypted_secrets where name = 'street_face_expiry_cron_token') <> 1 then
    raise exception 'Create exactly one street_face_expiry_cron_token in Supabase Vault first';
  end if;
end $$;

select cron.schedule(
  'street-face-stripe-sandbox-expiry-audit',
  '17 * * * *', -- once every hour, at 17 minutes past
  $$
    select net.http_post(
      url := 'https://ngmdsmmvdnbnxeozpfej.supabase.co/functions/v1/reconcile-checkout-expiry',
      headers := jsonb_build_object(
        'content-type', 'application/json',
        'x-reconciliation-token',
        (select decrypted_secret from vault.decrypted_secrets
         where name = 'street_face_expiry_cron_token')
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 30000
    );
  $$
);

-- To pause: select cron.unschedule('street-face-stripe-sandbox-expiry-audit');
-- To inspect: select * from cron.job_run_details order by start_time desc limit 10;
