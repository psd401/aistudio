WITH cur AS (SELECT studentid, subject, AVG(score) AS e, BOOL_OR(met_standard) AS met FROM smarter_balanced_scores
  WHERE yearid=35 AND grade_level=4 AND is_strand=false AND assessment_group LIKE 'Summative%' GROUP BY 1,2),
pri AS (SELECT studentid, subject, AVG(score) AS b FROM smarter_balanced_scores
  WHERE yearid=34 AND grade_level=3 AND is_strand=false AND assessment_group LIKE 'Summative%' GROUP BY 1,2),
m AS (SELECT 'SBA Chg ' || c.subject AS meas, c.studentid, c.e - p.b AS v
        FROM cur c JOIN pri p ON p.studentid=c.studentid AND p.subject=c.subject
      UNION ALL
      SELECT 'SBA Prof ' || subject, studentid, CASE WHEN met THEN 100.0 ELSE 0.0 END FROM cur),
sch AS (SELECT DISTINCT studentid FROM school_year_enrollments WHERE yearid=35 AND schoolid=3055 AND grade_level=4)
SELECT m.meas, sg.lbl, ROUND(AVG(v) FILTER (WHERE sch.studentid IS NOT NULL),1) AS a_sch, COUNT(sch.studentid) AS n_sch, ROUND(AVG(v),1) AS a_dist, COUNT(*) AS n_dist
FROM m
LEFT JOIN sch ON sch.studentid=m.studentid
LEFT JOIN students_frl fr ON fr.studentid=m.studentid
LEFT JOIN students_specialed sp2 ON sp2.studentid=m.studentid
CROSS JOIN LATERAL (VALUES ('Low Income', fr.frl IS TRUE), ('Non-Low Income', fr.frl IS FALSE), ('Special Ed', sp2.special_education IS TRUE), ('Non-Special Ed', sp2.special_education IS FALSE)) AS sg(lbl, inc)
WHERE sg.inc
GROUP BY 1,2 ORDER BY 1,2