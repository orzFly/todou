UPDATE attachments SET filename =
  'image-' || to_char(created_at AT TIME ZONE 'UTC', 'YYYYMMDD-HH24MISS')
          || '-' || id || substring(filename from '\.[^.]*$')
 WHERE filename ~* '^image\.(png|jpe?g|gif|webp|bmp|tiff?|avif)$';
--> statement-breakpoint
DO $$
DECLARE r record; ext text; base text; n int; candidate text;
BEGIN
  FOR r IN
    SELECT a.id, a.issue_id, a.filename FROM attachments a
     WHERE EXISTS (SELECT 1 FROM attachments b
                    WHERE b.issue_id = a.issue_id
                      AND lower(b.filename) = lower(a.filename)
                      AND b.id < a.id)
     ORDER BY a.id
  LOOP
    ext := CASE WHEN r.filename ~ '.\.[^.]*$'
                THEN substring(r.filename from '\.[^.]*$') ELSE '' END;
    base := left(r.filename, length(r.filename) - length(ext));
    candidate := base || '-' || r.id || ext;
    n := 1;
    WHILE EXISTS (SELECT 1 FROM attachments c
                   WHERE c.issue_id = r.issue_id
                     AND lower(c.filename) = lower(candidate)) LOOP
      n := n + 1;
      candidate := base || '-' || r.id || '-' || n || ext;
    END LOOP;
    UPDATE attachments SET filename = candidate WHERE id = r.id;
  END LOOP;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX "attachments_issue_filename_idx" ON "attachments" USING btree ("issue_id",lower("filename"));
