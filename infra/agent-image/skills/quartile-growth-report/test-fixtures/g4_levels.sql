WITH norms(meas0, per, cut, pr) AS (VALUES ('ORF WC','Fall',0,1),('ORF WC','Fall',7,2),('ORF WC','Fall',11,3),('ORF WC','Fall',14,4),('ORF WC','Fall',17,5),('ORF WC','Fall',19,6),('ORF WC','Fall',22,7),('ORF WC','Fall',26,8),('ORF WC','Fall',30,9),('ORF WC','Fall',33,10),('ORF WC','Fall',36,11),('ORF WC','Fall',39,12),('ORF WC','Fall',41,13),('ORF WC','Fall',44,14),('ORF WC','Fall',47,15),('ORF WC','Fall',49,16),('ORF WC','Fall',52,17),('ORF WC','Fall',54,18),('ORF WC','Fall',56,19),('ORF WC','Fall',58,20),('ORF WC','Fall',60,21),('ORF WC','Fall',62,22),('ORF WC','Fall',63,23),('ORF WC','Fall',64,24),('ORF WC','Fall',66,25),('ORF WC','Fall',67,27),('ORF WC','Fall',68,28),('ORF WC','Fall',70,29),('ORF WC','Fall',71,30),('ORF WC','Fall',72,31),('ORF WC','Fall',74,32),('ORF WC','Fall',75,33),('ORF WC','Fall',76,34),('ORF WC','Fall',77,35),('ORF WC','Fall',78,36),('ORF WC','Fall',79,37),('ORF WC','Fall',80,38),('ORF WC','Fall',81,39),('ORF WC','Fall',83,40),('ORF WC','Fall',84,41),('ORF WC','Fall',85,42),('ORF WC','Fall',86,43),('ORF WC','Fall',87,44),('ORF WC','Fall',88,45),('ORF WC','Fall',89,46),('ORF WC','Fall',90,47),('ORF WC','Fall',91,48),('ORF WC','Fall',92,49),('ORF WC','Fall',93,50),('ORF WC','Fall',94,51),('ORF WC','Fall',95,52),('ORF WC','Fall',96,53),('ORF WC','Fall',97,54),('ORF WC','Fall',98,55),('ORF WC','Fall',99,56),('ORF WC','Fall',100,57),('ORF WC','Fall',101,58),('ORF WC','Fall',102,59),('ORF WC','Fall',103,60),('ORF WC','Fall',104,61),('ORF WC','Fall',105,63),('ORF WC','Fall',106,64),('ORF WC','Fall',107,65),('ORF WC','Fall',108,66),('ORF WC','Fall',109,67),('ORF WC','Fall',110,68),('ORF WC','Fall',112,69),('ORF WC','Fall',113,70),('ORF WC','Fall',115,71),('ORF WC','Fall',116,72),('ORF WC','Fall',118,73),('ORF WC','Fall',119,74),('ORF WC','Fall',120,76),('ORF WC','Fall',122,77),('ORF WC','Fall',123,78),('ORF WC','Fall',124,79),('ORF WC','Fall',126,80),('ORF WC','Fall',127,82),('ORF WC','Fall',128,83),('ORF WC','Fall',130,84),('ORF WC','Fall',131,85),('ORF WC','Fall',132,86),('ORF WC','Fall',134,87),('ORF WC','Fall',136,88),('ORF WC','Fall',138,89),('ORF WC','Fall',140,90),('ORF WC','Fall',142,91),('ORF WC','Fall',144,92),('ORF WC','Fall',146,93),('ORF WC','Fall',148,94),('ORF WC','Fall',150,95),('ORF WC','Fall',152,96),('ORF WC','Fall',155,97),('ORF WC','Fall',159,98),('ORF WC','Fall',169,99),('ORF WC','Spring',0,1),('ORF WC','Spring',13,2),('ORF WC','Spring',18,3),('ORF WC','Spring',25,4),('ORF WC','Spring',31,5),('ORF WC','Spring',37,6),('ORF WC','Spring',44,7),('ORF WC','Spring',50,8),('ORF WC','Spring',56,9),('ORF WC','Spring',61,10),('ORF WC','Spring',66,11),('ORF WC','Spring',69,12),('ORF WC','Spring',73,13),('ORF WC','Spring',76,14),('ORF WC','Spring',79,15),('ORF WC','Spring',81,16),('ORF WC','Spring',84,17),('ORF WC','Spring',86,18),('ORF WC','Spring',89,19),('ORF WC','Spring',92,20),('ORF WC','Spring',94,21),('ORF WC','Spring',95,22),('ORF WC','Spring',96,23),('ORF WC','Spring',98,24),('ORF WC','Spring',99,25),('ORF WC','Spring',100,26),('ORF WC','Spring',102,27),('ORF WC','Spring',103,28),('ORF WC','Spring',105,29),('ORF WC','Spring',106,30),('ORF WC','Spring',107,31),('ORF WC','Spring',109,32),('ORF WC','Spring',110,33),('ORF WC','Spring',112,34),('ORF WC','Spring',113,35),('ORF WC','Spring',114,36),('ORF WC','Spring',115,37),('ORF WC','Spring',116,39),('ORF WC','Spring',117,40),('ORF WC','Spring',118,41),('ORF WC','Spring',119,42),('ORF WC','Spring',121,43),('ORF WC','Spring',122,45),('ORF WC','Spring',124,46),('ORF WC','Spring',125,47),('ORF WC','Spring',126,48),('ORF WC','Spring',127,50),('ORF WC','Spring',129,51),('ORF WC','Spring',130,53),('ORF WC','Spring',131,54),('ORF WC','Spring',132,55),('ORF WC','Spring',133,58),('ORF WC','Spring',135,59),('ORF WC','Spring',136,60),('ORF WC','Spring',137,61),('ORF WC','Spring',138,63),('ORF WC','Spring',139,64),('ORF WC','Spring',140,65),('ORF WC','Spring',141,68),('ORF WC','Spring',142,69),('ORF WC','Spring',143,70),('ORF WC','Spring',145,71),('ORF WC','Spring',146,73),('ORF WC','Spring',147,75),('ORF WC','Spring',149,76),('ORF WC','Spring',150,77),('ORF WC','Spring',151,78),('ORF WC','Spring',152,79),('ORF WC','Spring',153,81),('ORF WC','Spring',155,82),('ORF WC','Spring',158,83),('ORF WC','Spring',159,84),('ORF WC','Spring',160,85),('ORF WC','Spring',162,86),('ORF WC','Spring',164,88),('ORF WC','Spring',167,89),('ORF WC','Spring',169,90),('ORF WC','Spring',171,91),('ORF WC','Spring',173,92),('ORF WC','Spring',174,93),('ORF WC','Spring',175,94),('ORF WC','Spring',179,95),('ORF WC','Spring',181,96),('ORF WC','Spring',186,97),('ORF WC','Spring',192,98),('ORF WC','Spring',201,99)),
dst AS (SELECT d.assessment_group AS meas, mp.b0, d.studentid, d."window", AVG(d.score) AS s
  FROM dibels_scores d
  JOIN (VALUES ('ORF WC','Fall')) mp(m0, b0) ON mp.m0 = d.assessment_group
  WHERE d.yearid=35 AND d.grade_level=4 AND d."window" IN (mp.b0, 'Spring')
  GROUP BY 1,2,3,4),
dm AS (SELECT f.meas, f.studentid, f.s AS b, pb.pr AS bs, pe.pr AS es
  FROM dst f
  JOIN dst sp ON sp.studentid=f.studentid AND sp.meas=f.meas AND sp."window"='Spring'
  LEFT JOIN LATERAL (SELECT n.pr FROM norms n WHERE n.meas0=f.meas AND n.per=f.b0 AND n.cut <= f.s ORDER BY n.cut DESC LIMIT 1) pb ON true
  LEFT JOIN LATERAL (SELECT n.pr FROM norms n WHERE n.meas0=sp.meas AND n.per='Spring' AND n.cut <= sp.s ORDER BY n.cut DESC LIMIT 1) pe ON true
  WHERE f."window" = f.b0),
ist AS (SELECT 'iReady Reading' AS meas, studentid, "window", AVG(percentile) AS s
  FROM iready_reading_diagnostics WHERE yearid=35 AND grade_level=4 AND "window" IN ('Fall','Spring') GROUP BY 1,2,3
  UNION ALL
SELECT 'iReady Math' AS meas, studentid, "window", AVG(percentile) AS s
  FROM iready_math_diagnostics WHERE yearid=35 AND grade_level=4 AND "window" IN ('Fall','Spring') GROUP BY 1,2,3),
im AS (SELECT f.meas, f.studentid, f.s AS b, f.s AS bs, sp.s AS es
  FROM ist f JOIN ist sp ON sp.studentid=f.studentid AND sp.meas=f.meas AND sp."window"='Spring'
  WHERE f."window" <> 'Spring'),
m AS (SELECT * FROM dm UNION ALL SELECT * FROM im),
sch AS (SELECT DISTINCT studentid FROM school_year_enrollments WHERE yearid=35 AND schoolid=3055 AND grade_level=4),
mm AS (SELECT m.*, (sch.studentid IS NOT NULL) AS in_sch
       FROM m LEFT JOIN sch ON sch.studentid=m.studentid),
q AS (SELECT mm.*,
        NTILE(4) OVER (PARTITION BY meas, in_sch ORDER BY b, studentid) AS q_sch,
        NTILE(4) OVER (PARTITION BY meas ORDER BY b, studentid) AS q_dist
      FROM mm),
schq AS (SELECT meas, COALESCE(q_sch::text,'All') AS qt,
           ROUND(AVG(bs),0) AS s_start, ROUND(AVG(es),0) AS s_end, COUNT(*) AS n_sch
         FROM q WHERE in_sch GROUP BY GROUPING SETS ((meas, q_sch),(meas))),
distq AS (SELECT meas, COALESCE(q_dist::text,'All') AS qt,
           ROUND(AVG(bs),0) AS d_start, ROUND(AVG(es),0) AS d_end, COUNT(*) AS n_dist
          FROM q GROUP BY GROUPING SETS ((meas, q_dist),(meas)))
SELECT meas, qt, s_start, s_end, n_sch, d_start, d_end, n_dist
FROM distq LEFT JOIN schq USING (meas, qt)
ORDER BY meas, qt