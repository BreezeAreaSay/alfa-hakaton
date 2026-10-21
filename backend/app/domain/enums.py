from enum import StrEnum


class Role(StrEnum):
    CLIENT = "CLIENT"
    UNDERWRITER = "UNDERWRITER"
    ADMIN = "ADMIN"


class Actor(StrEnum):
    CLIENT = "CLIENT"
    SYSTEM = "SYSTEM"
    UNDERWRITER = "UNDERWRITER"
    ADMIN = "ADMIN"


class LegalForm(StrEnum):
    OOO = "OOO"
    IP = "IP"


class AppStatus(StrEnum):
    DRAFT = "DRAFT"
    SUBMITTED = "SUBMITTED"
    IN_PROCESSING = "IN_PROCESSING"
    NEED_INFO = "NEED_INFO"
    MANUAL_REVIEW = "MANUAL_REVIEW"
    OFFER = "OFFER"
    ACCEPTED = "ACCEPTED"
    SIGNING = "SIGNING"
    SIGNED = "SIGNED"
    ISSUED = "ISSUED"
    REJECTED = "REJECTED"
    DECLINED = "DECLINED"
    CANCELLED = "CANCELLED"
    EXPIRED = "EXPIRED"


FINAL_STATUSES = frozenset(
    {AppStatus.ISSUED, AppStatus.REJECTED, AppStatus.DECLINED, AppStatus.CANCELLED, AppStatus.EXPIRED}
)


class Purpose(StrEnum):
    WORKING_CAPITAL = "WORKING_CAPITAL"
    CASH_GAP = "CASH_GAP"
    EQUIPMENT = "EQUIPMENT"
    EXPANSION = "EXPANSION"


class StepCode(StrEnum):
    DATA_CHECK = "DATA_CHECK"
    EGRUL = "EGRUL"
    FNS = "FNS"
    GIRBO = "GIRBO"
    BKI = "BKI"
    BANK = "BANK"
    SCORING = "SCORING"
    POLICY = "POLICY"


PIPELINE_ORDER: tuple[StepCode, ...] = (
    StepCode.DATA_CHECK,
    StepCode.EGRUL,
    StepCode.FNS,
    StepCode.GIRBO,
    StepCode.BKI,
    StepCode.BANK,
    StepCode.SCORING,
    StepCode.POLICY,
)


class StepStatus(StrEnum):
    PENDING = "PENDING"
    RUNNING = "RUNNING"
    DONE = "DONE"
    SKIPPED = "SKIPPED"
    WAITING = "WAITING"
    FAILED = "FAILED"


class JobKind(StrEnum):
    PIPELINE_STEP = "PIPELINE_STEP"
    GENERATE_DOCS = "GENERATE_DOCS"
    DISBURSE = "DISBURSE"


class JobStatus(StrEnum):
    QUEUED = "QUEUED"
    RUNNING = "RUNNING"
    DONE = "DONE"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"


class DecisionKind(StrEnum):
    AUTO = "AUTO"
    MANUAL = "MANUAL"


class Outcome(StrEnum):
    APPROVE = "APPROVE"
    COUNTER = "COUNTER"
    REJECT = "REJECT"
    NEED_INFO = "NEED_INFO"
    MANUAL_REVIEW = "MANUAL_REVIEW"


class OfferKind(StrEnum):
    AS_REQUESTED = "AS_REQUESTED"
    COUNTER = "COUNTER"


class OfferStatus(StrEnum):
    ACTIVE = "ACTIVE"
    ACCEPTED = "ACCEPTED"
    DECLINED = "DECLINED"
    EXPIRED = "EXPIRED"
    VOID = "VOID"


class InfoOrigin(StrEnum):
    SYSTEM = "SYSTEM"
    UNDERWRITER = "UNDERWRITER"


class InfoStatus(StrEnum):
    OPEN = "OPEN"
    ANSWERED = "ANSWERED"
    EXPIRED = "EXPIRED"
    CANCELLED = "CANCELLED"


class DocumentKind(StrEnum):
    BANK_STATEMENT = "BANK_STATEMENT"
    FIN_STATEMENT = "FIN_STATEMENT"
    COLLATERAL = "COLLATERAL"
    OTHER = "OTHER"
    AGREEMENT = "AGREEMENT"
    SCHEDULE = "SCHEDULE"


class DocumentSource(StrEnum):
    CLIENT = "CLIENT"
    BANK = "BANK"
    GENERATED = "GENERATED"


class ConsentType(StrEnum):
    BKI = "BKI"
    PD = "PD"


class Audience(StrEnum):
    CLIENT = "CLIENT"
    BANK = "BANK"
    ALL = "ALL"
