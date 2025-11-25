/*
  # Complete Recurring Tasks Functionality Migration

  This migration creates the complete recurring tasks system that automatically generates 
  tasks based on daily, weekly, or monthly schedules.

  ## Features
  1. Recurring Tasks Table - Store task templates with recurrence rules
  2. Auto-generate Task IDs - Format: RETASK001, RETASK002, etc.
  3. Next Recurrence Calculation - Automatic scheduling of next occurrence
  4. Task Generation - Edge function creates tasks from templates
  5. Duplicate Prevention - Ensures one task per day per template
  6. Webhook Triggers - Integration with workflow automation

  ## Components
  - recurring_tasks table with all recurrence fields
  - Auto-ID generation trigger
  - Next recurrence auto-calculation trigger
  - Link to tasks table via recurrence_task_id
  - Workflow trigger events for webhooks
  - RLS policies for security

  ## Usage
  After running this migration:
  1. Deploy the generate-recurring-tasks edge function
  2. Set up a cron job to call the function (e.g., every hour)
  3. Create recurring tasks through the UI or API
  4. Tasks will automatically be created based on their schedule
*/

-- ============================================================================
-- STEP 1: Create recurring_tasks table with all fields
-- ============================================================================

CREATE TABLE IF NOT EXISTS recurring_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recurrence_task_id text UNIQUE,
  title text NOT NULL,
  description text,
  contact_id uuid REFERENCES contacts_master(id) ON DELETE SET NULL,
  assigned_to uuid REFERENCES admin_users(id) ON DELETE SET NULL,
  priority text NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
  category text,
  recurrence_type text NOT NULL CHECK (recurrence_type IN ('daily', 'weekly', 'monthly')),
  
  -- Start Date/Time fields
  start_time time NOT NULL,
  start_days text[], -- For weekly: ['mon', 'tue', etc.] - MUST be exactly 1 day
  start_day_of_month integer, -- For monthly: 1-31, or 0 for last day
  
  -- Due Date/Time fields
  due_time time NOT NULL,
  due_days text[], -- For weekly: ['mon', 'tue', etc.] - MUST be exactly 1 day
  due_day_of_month integer, -- For monthly: 1-31, or 0 for last day
  
  -- Supporting data
  supporting_docs jsonb DEFAULT '[]'::jsonb,
  
  -- Scheduling
  next_recurrence timestamptz,
  
  -- Status
  is_active boolean DEFAULT true,
  
  -- Audit fields
  created_by uuid REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Add constraints for recurrence fields
ALTER TABLE recurring_tasks
  ADD CONSTRAINT check_weekly_start_days
  CHECK (
    recurrence_type != 'weekly' OR
    (start_days IS NOT NULL AND array_length(start_days, 1) = 1)
  );

ALTER TABLE recurring_tasks
  ADD CONSTRAINT check_weekly_due_days
  CHECK (
    recurrence_type != 'weekly' OR
    (due_days IS NOT NULL AND array_length(due_days, 1) = 1)
  );

ALTER TABLE recurring_tasks
  ADD CONSTRAINT check_monthly_start_day
  CHECK (
    recurrence_type != 'monthly' OR
    (start_day_of_month IS NOT NULL AND start_day_of_month >= 0 AND start_day_of_month <= 31)
  );

ALTER TABLE recurring_tasks
  ADD CONSTRAINT check_monthly_due_day
  CHECK (
    recurrence_type != 'monthly' OR
    (due_day_of_month IS NOT NULL AND due_day_of_month >= 0 AND due_day_of_month <= 31)
  );

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_recurring_tasks_contact ON recurring_tasks(contact_id);
CREATE INDEX IF NOT EXISTS idx_recurring_tasks_assigned_to ON recurring_tasks(assigned_to);
CREATE INDEX IF NOT EXISTS idx_recurring_tasks_is_active ON recurring_tasks(is_active);
CREATE INDEX IF NOT EXISTS idx_recurring_tasks_recurrence_type ON recurring_tasks(recurrence_type);
CREATE INDEX IF NOT EXISTS idx_recurring_tasks_recurrence_task_id ON recurring_tasks(recurrence_task_id);
CREATE INDEX IF NOT EXISTS idx_recurring_tasks_next_recurrence ON recurring_tasks(next_recurrence) WHERE is_active = true;

-- Add comments
COMMENT ON TABLE recurring_tasks IS 'Stores recurring task templates that generate tasks automatically based on schedule';
COMMENT ON COLUMN recurring_tasks.recurrence_task_id IS 'Unique identifier in format RETASK001, RETASK002, etc. Auto-generated on insert.';
COMMENT ON COLUMN recurring_tasks.next_recurrence IS 'Timestamp of the next scheduled task creation. Updated after each task is created.';
COMMENT ON COLUMN recurring_tasks.start_days IS 'For weekly recurrence: exactly one day (mon/tue/wed/thu/fri/sat/sun)';
COMMENT ON COLUMN recurring_tasks.due_days IS 'For weekly recurrence: exactly one day (mon/tue/wed/thu/fri/sat/sun)';
COMMENT ON COLUMN recurring_tasks.start_day_of_month IS 'For monthly recurrence: 1-31 or 0 for last day of month';
COMMENT ON COLUMN recurring_tasks.due_day_of_month IS 'For monthly recurrence: 1-31 or 0 for last day of month';

-- ============================================================================
-- STEP 2: Enable RLS and create policies
-- ============================================================================

ALTER TABLE recurring_tasks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow anonymous read access to recurring_tasks"
  ON recurring_tasks FOR SELECT
  TO anon
  USING (true);

CREATE POLICY "Allow anonymous insert access to recurring_tasks"
  ON recurring_tasks FOR INSERT
  TO anon
  WITH CHECK (true);

CREATE POLICY "Allow anonymous update access to recurring_tasks"
  ON recurring_tasks FOR UPDATE
  TO anon
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Allow anonymous delete access to recurring_tasks"
  ON recurring_tasks FOR DELETE
  TO anon
  USING (true);

CREATE POLICY "Allow authenticated read access to recurring_tasks"
  ON recurring_tasks FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Allow authenticated insert access to recurring_tasks"
  ON recurring_tasks FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Allow authenticated update access to recurring_tasks"
  ON recurring_tasks FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Allow authenticated delete access to recurring_tasks"
  ON recurring_tasks FOR DELETE
  TO authenticated
  USING (true);

-- ============================================================================
-- STEP 3: Add recurrence_task_id field to tasks table for linking
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'tasks' AND column_name = 'recurrence_task_id'
  ) THEN
    ALTER TABLE tasks ADD COLUMN recurrence_task_id text;
    CREATE INDEX idx_tasks_recurrence_task_id ON tasks(recurrence_task_id);
    ALTER TABLE tasks
      ADD CONSTRAINT fk_tasks_recurrence_task_id
      FOREIGN KEY (recurrence_task_id) 
      REFERENCES recurring_tasks(recurrence_task_id)
      ON DELETE SET NULL;
    COMMENT ON COLUMN tasks.recurrence_task_id IS 'Links task to its recurring task template (RETASK001, RETASK002, etc.). Used to prevent duplicate creation.';
  END IF;
END $$;

-- ============================================================================
-- STEP 4: Auto-generate recurrence_task_id trigger
-- ============================================================================

CREATE OR REPLACE FUNCTION generate_recurrence_task_id()
RETURNS TRIGGER AS $$
DECLARE
  max_id INTEGER;
  new_id TEXT;
BEGIN
  IF NEW.recurrence_task_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(
    MAX(
      CAST(
        SUBSTRING(recurrence_task_id FROM 'RETASK(\d+)') AS INTEGER
      )
    ), 0
  ) INTO max_id
  FROM recurring_tasks
  WHERE recurrence_task_id IS NOT NULL;
  
  new_id := 'RETASK' || LPAD((max_id + 1)::TEXT, 3, '0');
  NEW.recurrence_task_id := new_id;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_recurrence_task_id ON recurring_tasks;
CREATE TRIGGER set_recurrence_task_id
  BEFORE INSERT ON recurring_tasks
  FOR EACH ROW
  WHEN (NEW.recurrence_task_id IS NULL)
  EXECUTE FUNCTION generate_recurrence_task_id();

COMMENT ON FUNCTION generate_recurrence_task_id() IS 'Auto-generates recurrence_task_id in format RETASK001, RETASK002, etc.';

-- ============================================================================
-- STEP 5: Auto-calculate next_recurrence trigger
-- ============================================================================

CREATE OR REPLACE FUNCTION recalculate_next_recurrence()
RETURNS TRIGGER AS $$
DECLARE
  v_now timestamptz;
  v_kolkata_time timestamp;
  v_next_recurrence timestamp;
  v_start_hour integer;
  v_start_minute integer;
  v_current_day_of_week text;
  v_days_of_week text[] := ARRAY['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  v_current_day_index integer;
  v_start_day_index integer;
  v_days_to_add integer := 7;
  v_diff integer;
  v_start_day integer;
BEGIN
  IF (TG_OP = 'INSERT') OR 
     (NEW.recurrence_type IS DISTINCT FROM OLD.recurrence_type) OR
     (NEW.start_time IS DISTINCT FROM OLD.start_time) OR
     (NEW.start_days IS DISTINCT FROM OLD.start_days) OR
     (NEW.start_day_of_month IS DISTINCT FROM OLD.start_day_of_month) THEN
    
    v_now := now();
    v_kolkata_time := v_now AT TIME ZONE 'Asia/Kolkata';
    v_next_recurrence := v_kolkata_time;
    
    v_start_hour := EXTRACT(HOUR FROM NEW.start_time);
    v_start_minute := EXTRACT(MINUTE FROM NEW.start_time);
    
    IF NEW.recurrence_type = 'daily' THEN
      v_next_recurrence := date_trunc('day', v_kolkata_time) + 
                          (v_start_hour || ' hours')::interval + 
                          (v_start_minute || ' minutes')::interval;
      IF v_next_recurrence <= v_kolkata_time THEN
        v_next_recurrence := v_next_recurrence + interval '1 day';
      END IF;
      
    ELSIF NEW.recurrence_type = 'weekly' THEN
      v_current_day_of_week := lower(to_char(v_kolkata_time, 'Dy'));
      v_current_day_index := array_position(v_days_of_week, v_current_day_of_week) - 1;
      
      IF NEW.start_days IS NOT NULL AND array_length(NEW.start_days, 1) > 0 THEN
        FOREACH v_current_day_of_week IN ARRAY NEW.start_days LOOP
          v_start_day_index := array_position(v_days_of_week, v_current_day_of_week) - 1;
          v_diff := v_start_day_index - v_current_day_index;
          IF v_diff < 0 THEN
            v_diff := v_diff + 7;
          END IF;
          IF v_diff = 0 THEN
            v_next_recurrence := date_trunc('day', v_kolkata_time) + 
                                (v_start_hour || ' hours')::interval + 
                                (v_start_minute || ' minutes')::interval;
            IF v_next_recurrence <= v_kolkata_time THEN
              v_diff := 7;
            END IF;
          END IF;
          IF v_diff < v_days_to_add THEN
            v_days_to_add := v_diff;
          END IF;
        END LOOP;
      END IF;
      
      v_next_recurrence := date_trunc('day', v_kolkata_time) + 
                          (v_days_to_add || ' days')::interval + 
                          (v_start_hour || ' hours')::interval + 
                          (v_start_minute || ' minutes')::interval;
      
    ELSIF NEW.recurrence_type = 'monthly' THEN
      v_start_day := NEW.start_day_of_month;
      
      IF v_start_day = 0 THEN
        v_start_day := EXTRACT(DAY FROM (date_trunc('month', v_kolkata_time) + interval '1 month' - interval '1 day'));
      END IF;
      
      v_next_recurrence := date_trunc('month', v_kolkata_time) + 
                          ((LEAST(v_start_day, EXTRACT(DAY FROM (date_trunc('month', v_kolkata_time) + interval '1 month' - interval '1 day'))::integer) - 1) || ' days')::interval + 
                          (v_start_hour || ' hours')::interval + 
                          (v_start_minute || ' minutes')::interval;
      
      IF v_next_recurrence <= v_kolkata_time THEN
        v_next_recurrence := date_trunc('month', v_kolkata_time) + interval '1 month';
        IF NEW.start_day_of_month = 0 THEN
          v_start_day := EXTRACT(DAY FROM (v_next_recurrence + interval '1 month' - interval '1 day'));
        ELSE
          v_start_day := NEW.start_day_of_month;
        END IF;
        v_next_recurrence := v_next_recurrence + 
                            ((LEAST(v_start_day, EXTRACT(DAY FROM (v_next_recurrence + interval '1 month' - interval '1 day'))::integer) - 1) || ' days')::interval + 
                            (v_start_hour || ' hours')::interval + 
                            (v_start_minute || ' minutes')::interval;
      END IF;
    END IF;
    
    NEW.next_recurrence := v_next_recurrence AT TIME ZONE 'Asia/Kolkata' AT TIME ZONE 'UTC';
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS recalculate_next_recurrence_on_change ON recurring_tasks;
CREATE TRIGGER recalculate_next_recurrence_on_change
  BEFORE INSERT OR UPDATE ON recurring_tasks
  FOR EACH ROW
  EXECUTE FUNCTION recalculate_next_recurrence();

COMMENT ON FUNCTION recalculate_next_recurrence() IS 'Automatically recalculates next_recurrence when schedule fields change';

-- ============================================================================
-- STEP 6: Updated_at trigger
-- ============================================================================

CREATE OR REPLACE FUNCTION update_recurring_tasks_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_recurring_tasks_updated_at ON recurring_tasks;
CREATE TRIGGER set_recurring_tasks_updated_at
  BEFORE UPDATE ON recurring_tasks
  FOR EACH ROW
  EXECUTE FUNCTION update_recurring_tasks_updated_at();

-- ============================================================================
-- STEP 7: Add workflow trigger events for webhooks
-- ============================================================================

INSERT INTO workflow_triggers (name, event_name, display_name, description, event_schema, category, is_active)
VALUES 
(
  'recurring-task-created',
  'RECURRING_TASK_CREATED',
  'Recurring Task Created',
  'Triggered when a new recurring task is created',
  '{
    "recurrence_task_id": "string",
    "title": "string",
    "description": "string",
    "contact_id": "string",
    "assigned_to": "string",
    "priority": "string",
    "recurrence_type": "string",
    "start_time": "string",
    "start_days": "array",
    "start_day_of_month": "number",
    "due_time": "string",
    "due_days": "array",
    "due_day_of_month": "number",
    "next_recurrence": "string",
    "is_active": "boolean",
    "created_at": "string",
    "trigger_event": "string"
  }'::jsonb,
  'Recurring Tasks',
  true
),
(
  'recurring-task-updated',
  'RECURRING_TASK_UPDATED',
  'Recurring Task Updated',
  'Triggered when a recurring task is updated',
  '{
    "recurrence_task_id": "string",
    "title": "string",
    "description": "string",
    "contact_id": "string",
    "assigned_to": "string",
    "priority": "string",
    "recurrence_type": "string",
    "start_time": "string",
    "start_days": "array",
    "start_day_of_month": "number",
    "due_time": "string",
    "due_days": "array",
    "due_day_of_month": "number",
    "next_recurrence": "string",
    "is_active": "boolean",
    "updated_at": "string",
    "trigger_event": "string"
  }'::jsonb,
  'Recurring Tasks',
  true
),
(
  'recurring-task-deleted',
  'RECURRING_TASK_DELETED',
  'Recurring Task Deleted',
  'Triggered when a recurring task is deleted',
  '{
    "recurrence_task_id": "string",
    "title": "string",
    "recurrence_type": "string",
    "trigger_event": "string"
  }'::jsonb,
  'Recurring Tasks',
  true
)
ON CONFLICT (name) DO NOTHING;

-- ============================================================================
-- STEP 8: Webhook trigger functions
-- ============================================================================

CREATE OR REPLACE FUNCTION send_recurring_task_created_webhook()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM net.http_post(
    url := webhook.url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || COALESCE(webhook.auth_token, '')
    ),
    body := jsonb_build_object(
      'recurrence_task_id', NEW.recurrence_task_id,
      'title', NEW.title,
      'description', NEW.description,
      'contact_id', NEW.contact_id,
      'assigned_to', NEW.assigned_to,
      'priority', NEW.priority,
      'recurrence_type', NEW.recurrence_type,
      'start_time', NEW.start_time,
      'start_days', NEW.start_days,
      'start_day_of_month', NEW.start_day_of_month,
      'due_time', NEW.due_time,
      'due_days', NEW.due_days,
      'due_day_of_month', NEW.due_day_of_month,
      'next_recurrence', NEW.next_recurrence,
      'is_active', NEW.is_active,
      'created_at', NEW.created_at,
      'trigger_event', 'RECURRING_TASK_CREATED'
    )
  )
  FROM api_webhooks webhook
  WHERE webhook.event = 'RECURRING_TASK_CREATED' AND webhook.is_active = true;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION send_recurring_task_updated_webhook()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM net.http_post(
    url := webhook.url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || COALESCE(webhook.auth_token, '')
    ),
    body := jsonb_build_object(
      'recurrence_task_id', NEW.recurrence_task_id,
      'title', NEW.title,
      'description', NEW.description,
      'contact_id', NEW.contact_id,
      'assigned_to', NEW.assigned_to,
      'priority', NEW.priority,
      'recurrence_type', NEW.recurrence_type,
      'start_time', NEW.start_time,
      'start_days', NEW.start_days,
      'start_day_of_month', NEW.start_day_of_month,
      'due_time', NEW.due_time,
      'due_days', NEW.due_days,
      'due_day_of_month', NEW.due_day_of_month,
      'next_recurrence', NEW.next_recurrence,
      'is_active', NEW.is_active,
      'updated_at', NEW.updated_at,
      'trigger_event', 'RECURRING_TASK_UPDATED'
    )
  )
  FROM api_webhooks webhook
  WHERE webhook.event = 'RECURRING_TASK_UPDATED' AND webhook.is_active = true;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION send_recurring_task_deleted_webhook()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM net.http_post(
    url := webhook.url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || COALESCE(webhook.auth_token, '')
    ),
    body := jsonb_build_object(
      'recurrence_task_id', OLD.recurrence_task_id,
      'title', OLD.title,
      'recurrence_type', OLD.recurrence_type,
      'trigger_event', 'RECURRING_TASK_DELETED'
    )
  )
  FROM api_webhooks webhook
  WHERE webhook.event = 'RECURRING_TASK_DELETED' AND webhook.is_active = true;
  
  RETURN OLD;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create webhook triggers
DROP TRIGGER IF EXISTS recurring_task_created_trigger ON recurring_tasks;
CREATE TRIGGER recurring_task_created_trigger
  AFTER INSERT ON recurring_tasks
  FOR EACH ROW
  EXECUTE FUNCTION send_recurring_task_created_webhook();

DROP TRIGGER IF EXISTS recurring_task_updated_trigger ON recurring_tasks;
CREATE TRIGGER recurring_task_updated_trigger
  AFTER UPDATE ON recurring_tasks
  FOR EACH ROW
  EXECUTE FUNCTION send_recurring_task_updated_webhook();

DROP TRIGGER IF EXISTS recurring_task_deleted_trigger ON recurring_tasks;
CREATE TRIGGER recurring_task_deleted_trigger
  AFTER DELETE ON recurring_tasks
  FOR EACH ROW
  EXECUTE FUNCTION send_recurring_task_deleted_webhook();

COMMENT ON FUNCTION send_recurring_task_created_webhook() IS 'Sends webhook notification when a recurring task is created';
COMMENT ON FUNCTION send_recurring_task_updated_webhook() IS 'Sends webhook notification when a recurring task is updated';
COMMENT ON FUNCTION send_recurring_task_deleted_webhook() IS 'Sends webhook notification when a recurring task is deleted';
