WITH cur AS (SELECT studentid, subject, BOOL_OR(met_standard) AS met FROM smarter_balanced_scores
  WHERE yearid=35 AND grade_level=5 AND is_strand=false AND assessment_group LIKE 'Summative%' GROUP BY 1,2),
hr AS (SELECT DISTINCT ON (studentid) studentid, sectionid FROM section_enrollments WHERE yearid=35 AND schoolid=3055 AND course_code='GR005' ORDER BY studentid, dateleft DESC),
sch AS (SELECT DISTINCT studentid FROM school_year_enrollments WHERE yearid=35 AND schoolid=3055 AND grade_level=5),
mm AS (SELECT c.subject AS meas, CASE WHEN c.met THEN 100.0 ELSE 0.0 END AS metv,
         hr.sectionid, (sch.studentid IS NOT NULL) AS in_sch
       FROM cur c LEFT JOIN hr ON hr.studentid=c.studentid LEFT JOIN sch ON sch.studentid=c.studentid)
SELECT meas, ROUND(AVG(metv) FILTER (WHERE sectionid=274386),0) AS p1, COUNT(*) FILTER (WHERE sectionid=274386) AS n1, ROUND(AVG(metv) FILTER (WHERE sectionid=274395),0) AS p2, COUNT(*) FILTER (WHERE sectionid=274395) AS n2, ROUND(AVG(metv) FILTER (WHERE sectionid=274431),0) AS p3, COUNT(*) FILTER (WHERE sectionid=274431) AS n3, ROUND(AVG(metv) FILTER (WHERE in_sch),0) AS p_sch, COUNT(*) FILTER (WHERE in_sch) AS n_sch, ROUND(AVG(metv),0) AS p_dist, COUNT(*) AS n_dist
FROM mm GROUP BY 1 ORDER BY 1