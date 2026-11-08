select id,status,fixed_cost,attempt_count,error_code,retry_of_analysis_id,
       created_at,started_at,finished_at,next_attempt_at
from public.analyses where id = '9cdf489d-6c6d-4e65-9f4c-7b0874632a26'::uuid;

select event_type,amount,created_at
from public.credit_ledger where analysis_id = '9cdf489d-6c6d-4e65-9f4c-7b0874632a26'::uuid
order by created_at,event_type;

select type,status,count(*)
from public.notification_events where analysis_id = '9cdf489d-6c6d-4e65-9f4c-7b0874632a26'::uuid
group by type,status;

select count(*) as findings from public.findings
where analysis_id = '9cdf489d-6c6d-4e65-9f4c-7b0874632a26'::uuid;

select jobname,active,schedule from cron.job
where jobname = 'kdm-analysis-recovery';