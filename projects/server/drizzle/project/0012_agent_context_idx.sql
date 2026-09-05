CREATE INDEX "comments_agent_idx" ON "comments" USING btree (("agent_context" ->> 'agent'));--> statement-breakpoint
CREATE INDEX "comments_session_idx" ON "comments" USING btree (("agent_context" ->> 'session_id'));--> statement-breakpoint
CREATE INDEX "issue_events_agent_idx" ON "issue_events" USING btree (("agent_context" ->> 'agent'));--> statement-breakpoint
CREATE INDEX "issue_events_session_idx" ON "issue_events" USING btree (("agent_context" ->> 'session_id'));--> statement-breakpoint
CREATE INDEX "spec_versions_agent_idx" ON "spec_versions" USING btree (("agent_context" ->> 'agent'));--> statement-breakpoint
CREATE INDEX "spec_versions_session_idx" ON "spec_versions" USING btree (("agent_context" ->> 'session_id'));