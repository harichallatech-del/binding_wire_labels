-- Binding Wire Label Studio: schema v2 (SQLite STRICT tables). Applied once by server.js; PRAGMA user_version tracks the version.
BEGIN;
CREATE TABLE product(                       -- what is printed; rows are immutable, so a reprint can never drift
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL, size TEXT NOT NULL, weight TEXT NOT NULL, quality TEXT NOT NULL, coil TEXT NOT NULL,
  UNIQUE(title,size,weight,quality,coil)
) STRICT;

CREATE TABLE batch(                         -- one lot = one manufacturing date + serial
  id INTEGER PRIMARY KEY,
  uid TEXT NOT NULL UNIQUE,                 -- time-ordered ULID-style id, never reused
  mfg_date TEXT NOT NULL CHECK(date(mfg_date) IS mfg_date),
  serial INTEGER NOT NULL CHECK(serial BETWEEN 1 AND 99),
  batch_no TEXT GENERATED ALWAYS AS (       -- lotnumbergenerator pattern minus expiry; derived, so it can never disagree with date+serial
    substr('ABCDEFGHIJKL',CAST(substr(mfg_date,6,2) AS INTEGER),1)||substr(mfg_date,3,1)||substr(mfg_date,9,2)||substr(mfg_date,4,1)||'-'||printf('%02d',serial)
  ) STORED,
  product_id INTEGER NOT NULL REFERENCES product(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN('active','void')),
  note TEXT,
  version INTEGER NOT NULL DEFAULT 1,       -- optimistic concurrency token
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(mfg_date,serial)
) STRICT;
CREATE UNIQUE INDEX ix_batch_no ON batch(batch_no);
CREATE INDEX ix_batch_seek ON batch(mfg_date DESC,serial DESC);   -- matches the keyset-pagination ORDER BY

CREATE TABLE print_job(                     -- append-only print log
  id INTEGER PRIMARY KEY,
  batch_id INTEGER NOT NULL REFERENCES batch(id),
  qty INTEGER NOT NULL CHECK(qty BETWEEN 1 AND 500),
  start_pos INTEGER NOT NULL DEFAULT 1 CHECK(start_pos>=1),
  printed_at TEXT NOT NULL
) STRICT;
CREATE INDEX ix_job_batch ON print_job(batch_id,printed_at DESC);
CREATE INDEX ix_job_time ON print_job(printed_at);

CREATE TABLE batch_label(                   -- one counted label identity per batch; reprints reuse sequence numbers
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES batch(id),
  sequence_no INTEGER NOT NULL CHECK(sequence_no BETWEEN 1 AND 500),
  created_at TEXT NOT NULL,
  UNIQUE(batch_id,sequence_no)
) STRICT;
CREATE INDEX ix_label_batch ON batch_label(batch_id,sequence_no);

CREATE TABLE batch_version(                 -- multi-version history: every superseded row version is kept (time travel)
  batch_id INTEGER NOT NULL REFERENCES batch(id),
  version INTEGER NOT NULL, status TEXT NOT NULL, note TEXT,
  valid_from TEXT NOT NULL, valid_to TEXT NOT NULL,
  PRIMARY KEY(batch_id,version)
) STRICT, WITHOUT ROWID;

CREATE TABLE setting(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT, WITHOUT ROWID;

CREATE TRIGGER batch_keep_version AFTER UPDATE ON batch BEGIN
  INSERT INTO batch_version VALUES(OLD.id,OLD.version,OLD.status,OLD.note,OLD.updated_at,NEW.updated_at);
END;
CREATE TRIGGER batch_version_step BEFORE UPDATE ON batch WHEN NEW.version<>OLD.version+1 BEGIN SELECT RAISE(ABORT,'version must increase by exactly 1 (optimistic locking)'); END;
CREATE TRIGGER batch_identity_locked BEFORE UPDATE OF uid,mfg_date,serial,product_id,created_at ON batch BEGIN SELECT RAISE(ABORT,'batch identity is immutable'); END;
CREATE TRIGGER batch_no_delete BEFORE DELETE ON batch BEGIN SELECT RAISE(ABORT,'batches are never deleted - void them'); END;
CREATE TRIGGER job_append_only_u BEFORE UPDATE ON print_job BEGIN SELECT RAISE(ABORT,'print log is append-only'); END;
CREATE TRIGGER job_append_only_d BEFORE DELETE ON print_job BEGIN SELECT RAISE(ABORT,'print log is append-only'); END;
CREATE TRIGGER job_active_only BEFORE INSERT ON print_job WHEN (SELECT status FROM batch WHERE id=NEW.batch_id)<>'active' BEGIN SELECT RAISE(ABORT,'cannot print a void batch'); END;
CREATE TRIGGER label_append_only_u BEFORE UPDATE ON batch_label BEGIN SELECT RAISE(ABORT,'label sequence is append-only'); END;
CREATE TRIGGER label_append_only_d BEFORE DELETE ON batch_label BEGIN SELECT RAISE(ABORT,'label sequence is append-only'); END;
CREATE TRIGGER product_locked BEFORE UPDATE ON product BEGIN SELECT RAISE(ABORT,'products are immutable'); END;

CREATE VIEW v_batch AS
SELECT b.id,b.uid,b.batch_no,b.mfg_date,b.serial,b.status,b.note,b.version,b.created_at,b.updated_at,
       p.id AS product_id,p.title,p.size,p.weight,p.quality,p.coil,
       (SELECT COALESCE(SUM(qty),0) FROM print_job j WHERE j.batch_id=b.id) AS labels,
       (SELECT COALESCE(MAX(sequence_no),0) FROM batch_label l WHERE l.batch_id=b.id) AS label_count,
       (SELECT COUNT(*) FROM print_job j WHERE j.batch_id=b.id) AS jobs,
       (SELECT MAX(printed_at) FROM print_job j WHERE j.batch_id=b.id) AS last_printed
FROM batch b JOIN product p ON p.id=b.product_id;

PRAGMA user_version=2;
COMMIT;
