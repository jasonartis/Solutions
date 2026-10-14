'use client'

import { useState } from 'react'

// Shown to someone with no organizations and no pending invitations. Joining
// is admin-adds-you (the admin types this exact address on their Members
// page, then you accept here), so the most useful thing is the address
// itself plus a message ready to send. Deliberately NO "find your
// organization" search: listing or probing org names would reveal which
// clients use the platform (see docs/18 item 8's 2026-10-14 note).
export default function JoinHelp({ email }: { email: string }) {
  const message = `Hi, please add me to our organization on Solutions Platform. My account email address is ${email}.`
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(message)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return (
    <section className="max-w-xl rounded-lg border border-gray-200 bg-white p-5 text-sm text-gray-700">
      <p>
        You are not a member of any organization yet. To join one, ask its administrator to add you using this
        email address: <span className="font-semibold">{email}</span>
      </p>
      <p className="mt-3 text-gray-500">Once they do, an invitation will appear here for you to accept.</p>
      <div className="mt-4 rounded border border-gray-200 bg-gray-50 p-3">
        <p className="mb-2 text-xs font-medium text-gray-500">A message you can send them:</p>
        <p data-testid="join-message">{message}</p>
        <button
          type="button"
          onClick={copy}
          className="mt-3 rounded border border-gray-300 bg-white px-3 py-1 text-xs font-medium hover:bg-gray-100"
        >
          {copied ? 'Copied' : 'Copy message'}
        </button>
      </div>
    </section>
  )
}
