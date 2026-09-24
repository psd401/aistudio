/**
 * Prod ECS scheduled scaling runs in Pacific local time.
 *
 * The schedules used to be UTC crons that assumed PST year-round and were never
 * adjusted for daylight saving, so MorningScaleUp fired at 8:30 PDT — after the
 * 6:30 agent morning-brief wave had already hit the 2-task overnight floor
 * (2026-09-23: one task at 100% CPU, 101 s ALB response time, agent workspace
 * save/restore timeouts). These assertions pin the local times and the explicit
 * time zone so the schedule cannot silently drift back to UTC.
 */
import * as cdk from 'aws-cdk-lib';
import {
  PROD_SCALING_SCHEDULES,
  PROD_SCALING_TIME_ZONE,
} from '../lib/constructs/ecs-service';

const byId = (id: string) => {
  const spec = PROD_SCALING_SCHEDULES.find((s) => s.id === id);
  if (!spec) throw new Error(`schedule ${id} not found`);
  return spec;
};

describe('prod ECS scheduled scaling', () => {
  it('evaluates every schedule in America/Los_Angeles', () => {
    expect(PROD_SCALING_TIME_ZONE).toBe(cdk.TimeZone.AMERICA_LOS_ANGELES);
    expect(PROD_SCALING_TIME_ZONE.timezoneName).toBe('America/Los_Angeles');
  });

  it('scales up on weekdays at 6:00 AM Pacific, before the agent brief wave', () => {
    expect(byId('MorningScaleUp')).toEqual({
      id: 'MorningScaleUp',
      hour: '6',
      minute: '0',
      weekDay: 'MON-FRI',
      minCapacity: 4,
      maxCapacity: 20,
    });
  });

  it('scales down on weekday evenings at 8:00 PM Pacific', () => {
    expect(byId('EveningScaleDown')).toMatchObject({
      hour: '20',
      minute: '0',
      weekDay: 'MON-FRI',
      minCapacity: 2,
      maxCapacity: 10,
    });
  });

  it('drops to the weekend floor at midnight Saturday Pacific', () => {
    expect(byId('WeekendScaling')).toMatchObject({
      hour: '0',
      minute: '0',
      weekDay: 'SAT',
      minCapacity: 1,
      maxCapacity: 5,
    });
  });

  it('keeps exactly the three schedule ids the stack has always used', () => {
    // Renaming an id replaces the CloudFormation ScheduledAction; keep them stable.
    expect(PROD_SCALING_SCHEDULES.map((s) => s.id)).toEqual([
      'MorningScaleUp',
      'EveningScaleDown',
      'WeekendScaling',
    ]);
  });
});
