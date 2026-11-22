IF DB_ID(N'library_management') IS NULL
  CREATE DATABASE library_management;
GO

USE library_management;
GO

IF OBJECT_ID(N'dbo.app_state', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.app_state (
    id TINYINT NOT NULL PRIMARY KEY,
    state_json NVARCHAR(MAX) NOT NULL,
    updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
  );
END;
GO

/* One-time upgrade: the old single "users" table is replaced by "students" and
   "admins". Every table below is a copy that the server rebuilds from the saved
   app state (app_state), so dropping the old tables loses nothing. */
IF OBJECT_ID(N'dbo.users', N'U') IS NOT NULL
BEGIN
  SET XACT_ABORT ON;
  BEGIN TRANSACTION;
  DROP TABLE IF EXISTS dbo.bookings;
  DROP TABLE IF EXISTS dbo.issues;
  DROP TABLE IF EXISTS dbo.fines;
  DROP TABLE IF EXISTS dbo.books;
  DROP TABLE dbo.users;
  COMMIT TRANSACTION;
END;
GO

IF OBJECT_ID(N'dbo.students', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.students (
    student_id BIGINT NOT NULL PRIMARY KEY,
    roll NVARCHAR(50) NOT NULL UNIQUE,
    email NVARCHAR(255) NULL,
    name NVARCHAR(150) NOT NULL,
    academic_year NVARCHAR(30) NULL,
    department NVARCHAR(150) NULL,
    class_section NVARCHAR(30) NULL,
    password_hash NVARCHAR(255) NOT NULL,
    profile_picture NVARCHAR(MAX) NULL,
    created_at DATETIME2 NOT NULL DEFAULT SYSDATETIME()
  );
  CREATE UNIQUE INDEX UX_students_email ON dbo.students (email) WHERE email IS NOT NULL;
END;
GO

IF OBJECT_ID(N'dbo.admins', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.admins (
    admin_id BIGINT NOT NULL PRIMARY KEY,
    roll NVARCHAR(50) NOT NULL UNIQUE,
    email NVARCHAR(255) NULL,
    name NVARCHAR(150) NOT NULL,
    password_hash NVARCHAR(255) NOT NULL,
    profile_picture NVARCHAR(MAX) NULL,
    created_at DATETIME2 NOT NULL DEFAULT SYSDATETIME()
  );
  CREATE UNIQUE INDEX UX_admins_email ON dbo.admins (email) WHERE email IS NOT NULL;
END;
GO

IF OBJECT_ID(N'dbo.books', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.books (
    book_id BIGINT NOT NULL PRIMARY KEY,
    title NVARCHAR(300) NOT NULL,
    author NVARCHAR(200) NOT NULL,
    category NVARCHAR(150) NULL,
    available_copies INT NOT NULL CONSTRAINT CK_books_available_copies CHECK (available_copies >= 0),
    total_copies INT NOT NULL CONSTRAINT CK_books_total_copies CHECK (total_copies >= 0),
    end_date DATE NULL,
    fine_per_day DECIMAL(10, 2) NOT NULL DEFAULT 0 CONSTRAINT CK_books_fine CHECK (fine_per_day >= 0),
    borrowed_by_roll NVARCHAR(50) NULL,
    CONSTRAINT FK_books_borrowed_by FOREIGN KEY (borrowed_by_roll) REFERENCES dbo.students (roll)
  );
END;
GO

IF OBJECT_ID(N'dbo.fines', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.fines (
    fine_id BIGINT NOT NULL PRIMARY KEY,
    roll NVARCHAR(50) NOT NULL,
    amount DECIMAL(10, 2) NOT NULL CONSTRAINT CK_fines_amount CHECK (amount > 0),
    reason NVARCHAR(300) NOT NULL,
    paid BIT NOT NULL DEFAULT 0,
    created_at DATETIME2 NOT NULL DEFAULT SYSDATETIME(),
    CONSTRAINT FK_fines_user FOREIGN KEY (roll) REFERENCES dbo.students (roll)
  );
END;
GO

IF OBJECT_ID(N'dbo.bookings', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.bookings (
    booking_id BIGINT NOT NULL PRIMARY KEY,
    book_id BIGINT NOT NULL,
    title NVARCHAR(300) NOT NULL,
    name NVARCHAR(150) NOT NULL,
    roll NVARCHAR(50) NOT NULL,
    email NVARCHAR(255) NULL,
    start_date DATE NOT NULL,
    due_date DATE NOT NULL,
    fine_accepted BIT NOT NULL DEFAULT 0,
    copies INT NOT NULL CONSTRAINT CK_bookings_copies CHECK (copies > 0),
    accepted BIT NOT NULL DEFAULT 0,
    created_at DATETIME2 NOT NULL DEFAULT SYSDATETIME(),
    CONSTRAINT FK_bookings_book FOREIGN KEY (book_id) REFERENCES dbo.books (book_id),
    CONSTRAINT FK_bookings_user FOREIGN KEY (roll) REFERENCES dbo.students (roll)
  );
END;
GO

IF OBJECT_ID(N'dbo.issues', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.issues (
    issue_id BIGINT NOT NULL PRIMARY KEY,
    book_id BIGINT NOT NULL,
    title NVARCHAR(300) NOT NULL,
    name NVARCHAR(150) NOT NULL,
    roll NVARCHAR(50) NOT NULL,
    email NVARCHAR(255) NULL,
    start_date DATE NOT NULL,
    due_date DATE NOT NULL,
    fine_accepted BIT NOT NULL DEFAULT 0,
    copies INT NOT NULL CONSTRAINT CK_issues_copies CHECK (copies > 0),
    note NVARCHAR(1000) NULL,
    accepted BIT NOT NULL DEFAULT 0,
    added_copies INT NULL,
    created_at DATETIME2 NOT NULL DEFAULT SYSDATETIME(),
    CONSTRAINT FK_issues_book FOREIGN KEY (book_id) REFERENCES dbo.books (book_id),
    CONSTRAINT FK_issues_user FOREIGN KEY (roll) REFERENCES dbo.students (roll)
  );
END;
GO

IF OBJECT_ID(N'dbo.history', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.history (
    history_id BIGINT NOT NULL PRIMARY KEY,
    happened_at DATETIME2 NOT NULL,
    actor_type NVARCHAR(20) NOT NULL,
    actor NVARCHAR(150) NOT NULL,
    event_text NVARCHAR(1000) NOT NULL,
    data_json NVARCHAR(MAX) NULL
  );
END;
GO

IF OBJECT_ID(N'dbo.preferences', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.preferences (
    preference_key NVARCHAR(100) NOT NULL PRIMARY KEY,
    preference_value NVARCHAR(MAX) NOT NULL,
    updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
  );
END;
GO

IF OBJECT_ID(N'dbo.storage', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.storage (
    storage_key NVARCHAR(255) NOT NULL PRIMARY KEY,
    storage_value NVARCHAR(MAX) NOT NULL,
    updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
  );
END;
GO