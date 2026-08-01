import bcrypt from 'bcryptjs'
import { eq } from 'drizzle-orm'
import { db } from '../db/client'
import { admins } from '../db/schema'

// 관리자 계정 서비스. 비밀번호는 항상 bcrypt 해시로 저장/검증한다 (평문 저장 금지).

const BCRYPT_ROUNDS = 10

export async function verifyAdmin(username: string, password: string): Promise<boolean> {
  const rows = await db.select().from(admins).where(eq(admins.username, username)).limit(1)
  if (rows.length === 0) return false
  return bcrypt.compareSync(password, rows[0].passwordHash)
}

export async function listAdmins() {
  return db
    .select({ id: admins.id, username: admins.username, createdAt: admins.createdAt })
    .from(admins)
    .orderBy(admins.id)
}

export async function countAdmins(): Promise<number> {
  const rows = await db.select({ id: admins.id }).from(admins)
  return rows.length
}

export async function usernameExists(username: string): Promise<boolean> {
  const rows = await db.select({ id: admins.id }).from(admins).where(eq(admins.username, username)).limit(1)
  return rows.length > 0
}

export async function createAdmin(username: string, password: string): Promise<void> {
  const passwordHash = bcrypt.hashSync(password, BCRYPT_ROUNDS)
  await db.insert(admins).values({ username, passwordHash })
}

export async function deleteAdmin(id: number): Promise<void> {
  await db.delete(admins).where(eq(admins.id, id))
}

/** admins 테이블이 비어 있으면 .env 계정으로 첫 관리자를 생성(시딩)한다. */
export async function seedFirstAdmin(username: string, password: string): Promise<void> {
  if (!username || !password) return
  if ((await countAdmins()) > 0) return
  await createAdmin(username, password)
  console.log(`[admin] 첫 관리자 시딩됨: ${username}`)
}
