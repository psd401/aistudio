WITH dst AS (SELECT d.assessment_group AS meas, mp.b0, d.studentid, d."window", AVG(d.score) AS s
  FROM dibels_scores d
  JOIN (VALUES ('LNF','Fall'), ('PSF','Fall'), ('NWF CLS','Fall'), ('NWF WRC','Fall'), ('ORF WC','Winter'), ('ORF Accuracy','Winter')) mp(m0, b0) ON mp.m0 = d.assessment_group
  WHERE d.yearid=35 AND d.grade_level=1 AND d."window" IN (mp.b0, 'Spring')
  GROUP BY 1,2,3,4),
dm AS (SELECT 'D:' || f.meas AS meas, f.studentid, sp.s - f.s AS chg
  FROM dst f
  JOIN dst sp ON sp.studentid=f.studentid AND sp.meas=f.meas AND sp."window"='Spring'
  WHERE f."window" = f.b0),
ist AS (SELECT 'iReady Reading' AS meas, studentid, "window", AVG(percentile) AS s
  FROM iready_reading_diagnostics WHERE yearid=35 AND grade_level=1 AND "window" IN ('Fall','Spring') GROUP BY 1,2,3
  UNION ALL
SELECT 'iReady Math' AS meas, studentid, "window", AVG(percentile) AS s
  FROM iready_math_diagnostics WHERE yearid=35 AND grade_level=1 AND "window" IN ('Fall','Spring') GROUP BY 1,2,3),
im AS (SELECT f.meas, f.studentid, sp.s - f.s AS chg
  FROM ist f JOIN ist sp ON sp.studentid=f.studentid AND sp.meas=f.meas AND sp."window"='Spring'
  WHERE f."window" <> 'Spring'),
m AS (SELECT * FROM dm UNION ALL SELECT * FROM im),
sch AS (SELECT DISTINCT studentid FROM school_year_enrollments WHERE yearid=35 AND schoolid=3055 AND grade_level=1)
SELECT m.meas, sg.lbl, ROUND(AVG(chg) FILTER (WHERE sch.studentid IS NOT NULL),1) AS a_sch, COUNT(sch.studentid) AS n_sch, ROUND(AVG(chg),1) AS a_dist, COUNT(*) AS n_dist
FROM m
LEFT JOIN sch ON sch.studentid=m.studentid
LEFT JOIN students_frl fr ON fr.studentid=m.studentid
LEFT JOIN students_specialed sp2 ON sp2.studentid=m.studentid
CROSS JOIN LATERAL (VALUES ('Low Income', fr.frl IS TRUE), ('Non-Low Income', fr.frl IS FALSE), ('Special Ed', sp2.special_education IS TRUE), ('Non-Special Ed', sp2.special_education IS FALSE)) AS sg(lbl, inc)
WHERE sg.inc
GROUP BY 1,2 ORDER BY 1,2