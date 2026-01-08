-- Migration: Add Activity Dashboard Navigation Item
-- Issue: #612 - Admin Activity Dashboard

-- Add Activity Dashboard to Admin section
-- Parent ID 11 is the "Admin" section
-- Position 25 places it between User Management (20) and Navigation Manager (30)
INSERT INTO navigation_items (label, icon, link, parent_id, requires_role, position, is_active, type, description)
SELECT 'Activity Dashboard', 'IconActivity', '/admin/activity', 11, 'administrator', 25, true, 'link', 'Monitor platform usage across Nexus, Assistant Architect, and Model Compare'
WHERE NOT EXISTS (
    SELECT 1 FROM navigation_items WHERE link = '/admin/activity'
);
