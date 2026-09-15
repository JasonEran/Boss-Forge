ALTER TABLE communication_wechat_actions DROP CONSTRAINT communication_wechat_actions_action_kind_check;
ALTER TABLE communication_wechat_actions ADD CONSTRAINT communication_wechat_actions_action_kind_check CHECK (action_kind IN ('wechat','resume','resume_accept'));
ALTER TABLE communication_wechat_actions ADD COLUMN provider_message_id text;
ALTER TABLE communication_wechat_actions ADD CONSTRAINT communication_resume_accept_message_check CHECK (action_kind <> 'resume_accept' OR (provider_message_id IS NOT NULL AND length(provider_message_id) BETWEEN 1 AND 512));
