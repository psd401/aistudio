WITH base AS (
  SELECT 'ELA' AS subject, studentid, AVG(percentile) AS b FROM iready_reading_diagnostics WHERE yearid=35 AND grade_level=3 AND "window"='Fall' GROUP BY 2
  UNION ALL
  SELECT 'Math', studentid, AVG(percentile) FROM iready_math_diagnostics WHERE yearid=35 AND grade_level=3 AND "window"='Fall' GROUP BY 2),
cur AS (SELECT studentid, subject, AVG(score) AS e, BOOL_OR(met_standard) AS met FROM smarter_balanced_scores
  WHERE yearid=35 AND grade_level=3 AND is_strand=false AND assessment_group LIKE 'Summative%' GROUP BY 1,2),
m AS (SELECT c.subject AS meas, c.studentid, b.b, c.e, CASE WHEN c.met THEN 100.0 ELSE 0.0 END AS metv
      FROM cur c JOIN base b ON b.studentid=c.studentid AND b.subject=c.subject),
hr AS (SELECT DISTINCT ON (studentid) studentid, sectionid FROM section_enrollments WHERE yearid=35 AND schoolid=3055 AND course_code='GR003' ORDER BY studentid, dateleft DESC),
sch AS (SELECT DISTINCT studentid FROM school_year_enrollments WHERE yearid=35 AND schoolid=3055 AND grade_level=3),
mm AS (SELECT m.*, hr.sectionid, (sch.studentid IS NOT NULL) AS in_sch
       FROM m LEFT JOIN hr ON hr.studentid=m.studentid LEFT JOIN sch ON sch.studentid=m.studentid),
q AS (SELECT mm.*,
        NTILE(4) OVER (PARTITION BY meas, sectionid ORDER BY b, studentid) AS q_cls,
        NTILE(4) OVER (PARTITION BY meas, in_sch ORDER BY b, studentid) AS q_sch,
        NTILE(4) OVER (PARTITION BY meas ORDER BY b, studentid) AS q_dist
      FROM mm),
cls AS (SELECT meas, COALESCE(q_cls::text,'All') AS qt, ROUND(AVG(e) FILTER (WHERE sectionid=274382),1) AS a1, ROUND(AVG(metv) FILTER (WHERE sectionid=274382),1) AS p1, COUNT(*) FILTER (WHERE sectionid=274382) AS n1, ROUND(AVG(e) FILTER (WHERE sectionid=274392),1) AS a2, ROUND(AVG(metv) FILTER (WHERE sectionid=274392),1) AS p2, COUNT(*) FILTER (WHERE sectionid=274392) AS n2, ROUND(AVG(e) FILTER (WHERE sectionid=274423),1) AS a3, ROUND(AVG(metv) FILTER (WHERE sectionid=274423),1) AS p3, COUNT(*) FILTER (WHERE sectionid=274423) AS n3
        FROM q WHERE sectionid IS NOT NULL GROUP BY GROUPING SETS ((meas, q_cls),(meas))),
scha AS (SELECT meas, COALESCE(q_sch::text,'All') AS qt, ROUND(AVG(e),1) AS a_sch, ROUND(AVG(metv),1) AS p_sch, COUNT(*) AS n_sch
        FROM q WHERE in_sch GROUP BY GROUPING SETS ((meas, q_sch),(meas))),
dist AS (SELECT meas, COALESCE(q_dist::text,'All') AS qt, ROUND(AVG(e),1) AS a_dist, ROUND(AVG(metv),1) AS p_dist, COUNT(*) AS n_dist
        FROM q GROUP BY GROUPING SETS ((meas, q_dist),(meas)))
SELECT meas, qt, a1, p1, n1, a2, p2, n2, a3, p3, n3, a_sch, p_sch, n_sch, a_dist, p_dist, n_dist
FROM dist LEFT JOIN scha USING (meas, qt) LEFT JOIN cls USING (meas, qt)
ORDER BY meas, qt