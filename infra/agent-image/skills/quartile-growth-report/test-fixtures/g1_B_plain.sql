WITH stu AS (SELECT 'iReady Reading' AS meas, studentid, "window", AVG(percentile) AS s
  FROM iready_reading_diagnostics WHERE yearid=35 AND grade_level=1 AND "window" IN ('Fall','Spring') GROUP BY 2,3
  UNION ALL
SELECT 'iReady Math' AS meas, studentid, "window", AVG(percentile) AS s
  FROM iready_math_diagnostics WHERE yearid=35 AND grade_level=1 AND "window" IN ('Fall','Spring') GROUP BY 2,3
  UNION ALL
SELECT 'D:ORF Accuracy', studentid, "window", AVG(score)
  FROM dibels_scores WHERE yearid=35 AND grade_level=1 AND assessment_group='ORF Accuracy' AND "window" IN ('Winter','Spring') GROUP BY 2,3),
m AS (SELECT f.meas, f.studentid, f.s AS b, sp.s AS e
  FROM stu f JOIN stu sp ON sp.studentid=f.studentid AND sp.meas=f.meas
  WHERE f."window" = CASE WHEN f.meas = 'D:ORF Accuracy' THEN 'Winter' ELSE 'Fall' END AND sp."window"='Spring'),
hr AS (SELECT DISTINCT ON (studentid) studentid, sectionid FROM section_enrollments WHERE yearid=35 AND schoolid=3055 AND course_code='GR001' ORDER BY studentid, dateleft DESC),
sch AS (SELECT DISTINCT studentid FROM school_year_enrollments WHERE yearid=35 AND schoolid=3055 AND grade_level=1),
mm AS (SELECT m.*, hr.sectionid, (sch.studentid IS NOT NULL) AS in_sch
       FROM m LEFT JOIN hr ON hr.studentid=m.studentid LEFT JOIN sch ON sch.studentid=m.studentid),
q AS (SELECT mm.*,
        NTILE(4) OVER (PARTITION BY meas, sectionid ORDER BY b, studentid) AS q_cls,
        NTILE(4) OVER (PARTITION BY meas, in_sch ORDER BY b, studentid) AS q_sch,
        NTILE(4) OVER (PARTITION BY meas ORDER BY b, studentid) AS q_dist
      FROM mm),
cls AS (SELECT meas, COALESCE(q_cls::text,'All') AS qt, ROUND(AVG(e-b) FILTER (WHERE sectionid=274398),1) AS a1, COUNT(*) FILTER (WHERE sectionid=274398) AS n1, ROUND(AVG(e-b) FILTER (WHERE sectionid=274349),1) AS a2, COUNT(*) FILTER (WHERE sectionid=274349) AS n2
        FROM q WHERE sectionid IS NOT NULL GROUP BY GROUPING SETS ((meas, q_cls),(meas))),
scha AS (SELECT meas, COALESCE(q_sch::text,'All') AS qt, ROUND(AVG(e-b),1) AS a_sch, COUNT(*) AS n_sch
        FROM q WHERE in_sch GROUP BY GROUPING SETS ((meas, q_sch),(meas))),
dist AS (SELECT meas, COALESCE(q_dist::text,'All') AS qt, ROUND(AVG(e-b),1) AS a_dist, COUNT(*) AS n_dist
        FROM q GROUP BY GROUPING SETS ((meas, q_dist),(meas)))
SELECT meas, qt, a1, n1, a2, n2, a_sch, n_sch, a_dist, n_dist
FROM dist LEFT JOIN scha USING (meas, qt) LEFT JOIN cls USING (meas, qt)
ORDER BY meas, qt