WITH cur AS (SELECT studentid, subject, BOOL_OR(met_standard) AS met FROM smarter_balanced_scores
  WHERE yearid=35 AND grade_level=3 AND is_strand=false AND assessment_group LIKE 'Summative%' GROUP BY 1,2),
m AS (SELECT subject AS meas, studentid, CASE WHEN met THEN 100.0 ELSE 0.0 END AS metv FROM cur),
sch AS (SELECT DISTINCT studentid FROM school_year_enrollments WHERE yearid=35 AND schoolid=3055 AND grade_level=3)
SELECT m.meas, sg.lbl, ROUND(AVG(metv) FILTER (WHERE sch.studentid IS NOT NULL),0) AS p_sch, COUNT(sch.studentid) AS n_sch, ROUND(AVG(metv),0) AS p_dist, COUNT(*) AS n_dist
FROM m
LEFT JOIN sch ON sch.studentid=m.studentid
LEFT JOIN students_frl fr ON fr.studentid=m.studentid
LEFT JOIN students_specialed sp2 ON sp2.studentid=m.studentid
CROSS JOIN LATERAL (VALUES ('Low Income', fr.frl IS TRUE), ('Non-Low Income', fr.frl IS FALSE), ('Special Ed', sp2.special_education IS TRUE), ('Non-Special Ed', sp2.special_education IS FALSE)) AS sg(lbl, inc)
WHERE sg.inc
GROUP BY 1,2 ORDER BY 1,2