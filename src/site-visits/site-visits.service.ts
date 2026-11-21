import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

// Days are Bangladesh days, like every other per-day count.
export const TIME_ZONE = 'Asia/Dhaka';
// How many days the /status page's daily chart shows, today included.
export const HISTORY_DAYS = 30;

export type CountryCount = { country: string | null; visitors: number };
export type DayCount = { date: string; visitors: number };

@Injectable()
export class SiteVisitsService {
  constructor(private readonly prisma: PrismaService) {}

  // One row per visitor per day: a second visit the same day changes nothing.
  async record(visitor: string, country: string | null): Promise<void> {
    await this.prisma.$executeRaw`
      INSERT INTO site_visits (day, visitor_hash, country)
      VALUES ((now() AT TIME ZONE ${TIME_ZONE})::date, ${visitor}, ${country})
      ON CONFLICT (day, visitor_hash) DO NOTHING`;
  }

  // Visitors per country on `date` (today when null), plus the daily totals
  // for the last HISTORY_DAYS days. Dates go out as text: the pg driver would
  // shift a `date` value into the server's local time.
  async stats(date: string | null) {
    const [countries, days] = await Promise.all([
      this.prisma.$queryRaw<{ country: string | null; visitors: number }[]>`
        SELECT country, count(*)::int AS visitors
        FROM site_visits
        WHERE day = COALESCE(${date}::date, (now() AT TIME ZONE ${TIME_ZONE})::date)
        GROUP BY country
        ORDER BY visitors DESC, country NULLS LAST`,
      this.prisma.$queryRaw<{ date: string; visitors: number }[]>`
        WITH today AS (SELECT (now() AT TIME ZONE ${TIME_ZONE})::date AS d)
        SELECT to_char(g.day, 'YYYY-MM-DD') AS date,
               count(v.visitor_hash)::int AS visitors
        FROM today,
             generate_series(today.d - ${HISTORY_DAYS - 1}::int, today.d, interval '1 day') AS g(day)
        LEFT JOIN site_visits v ON v.day = g.day::date
        GROUP BY g.day
        ORDER BY g.day`,
    ]);
    const today = days[days.length - 1].date;
    const selected = date ?? today;
    return {
      time_zone: TIME_ZONE,
      today,
      date: selected,
      total: countries.reduce((sum, c) => sum + c.visitors, 0),
      countries: countries as CountryCount[],
      days: days as DayCount[],
    };
  }
}
