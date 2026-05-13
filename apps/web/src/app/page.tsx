import { redirect } from 'next/navigation'

export default function Home() {
  // v2 是新版（奶米暖色 + 柿色 accent），老 /login 还在但不再是默认入口
  redirect('/v2/login')
}
