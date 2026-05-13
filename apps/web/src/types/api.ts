// ── 核心枚举 ──────────────────────────────────────────
export type OrderStatus =
  | 'DRAFT' | 'SUBMITTED' | 'CONFIRMED' | 'DELIVERING'
  | 'PENDING_CONFIRM' | 'RECEIVED' | 'COMPLETED' | 'CANCELLED'

export type ReceiptStatus =
  | 'DRAFT' | 'PENDING_CONFIRM' | 'CONFIRMED' | 'ACCOUNTED' | 'VOID' | 'REJECTED'

export type ScheduleStatus =
  | 'PENDING' | 'PENDING_APPROVAL' | 'APPROVED' | 'NOTIFIED'
  | 'PROCESSING' | 'PAID' | 'OVERDUE' | 'CANCELLED' | 'REJECTED'

export type UserRole =
  | 'SUPER_ADMIN' | 'ADMIN' | 'FINANCE' | 'MANAGER' | 'PURCHASER' | 'SUPPLIER_STAFF'

// ── 基础实体 ──────────────────────────────────────────
export interface Store {
  id: string
  no: string
  name: string
  address?: string
  phone?: string
  status: 'ENABLED' | 'DISABLED'
}

export interface Supplier {
  id: string
  no: string
  name: string
  bankAccount?: string
  bankName?: string
  contactName?: string
  phone?: string
  creditType: 'FIXED_DAYS' | 'MONTHLY' | 'WEEKLY' | 'ON_DELIVERY'
  creditDays: number
  status: 'ENABLED' | 'DISABLED'
}

export interface Product {
  id: string
  name: string
  unit: string
  category?: string
  price: number
  stock: number
  minStock: number
  status: 'ENABLED' | 'DISABLED'
  supplier?: Pick<Supplier, 'id' | 'name'>
}

// ── 采购订单 ──────────────────────────────────────────
export interface OrderItem {
  id: string
  productId: string
  product: Pick<Product, 'name' | 'unit'>
  quantity: number
  unitPrice: number
  amount: number
}

export interface PurchaseOrder {
  id: string
  no: string
  status: OrderStatus
  expectedDate: string
  totalAmount: number
  note?: string
  createdAt: string
  store?: Pick<Store, 'id' | 'name'>
  supplier?: Pick<Supplier, 'id' | 'name'>
  createdBy?: { id: string; name: string }
  items: OrderItem[]
}

// ── 入库单 ────────────────────────────────────────────
export interface ReceiptItem {
  id: string
  productId: string
  product: Pick<Product, 'id' | 'name' | 'unit'>
  quantity: number
  unitPrice: number
  amount: number
  receivedQty?: number
  lossQty?: number
}

export interface Receipt {
  id: string
  no: string
  status: ReceiptStatus
  deliveryDate: string
  totalAmount: number
  note?: string
  isManual?: boolean
  createdAt: string
  store?: Pick<Store, 'id' | 'name'>
  supplier?: Pick<Supplier, 'id' | 'name'>
  createdBy?: { id: string; name: string }
  items: ReceiptItem[]
  paymentSchedule?: PaymentSchedule
}

// ── 账期 ──────────────────────────────────────────────
export interface PaymentSchedule {
  id: string
  status: ScheduleStatus
  amount: number
  dueAt: string
  createdAt: string
  supplier?: Pick<Supplier, 'id' | 'name' | 'creditType' | 'creditDays'>
  receipt?: Pick<Receipt, 'id' | 'no'> & { store?: Pick<Store, 'name'> }
}

// ── 分页响应 ──────────────────────────────────────────
export interface PaginatedResponse<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
}
