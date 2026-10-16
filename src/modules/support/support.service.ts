import { Types } from 'mongoose'
import { HTTP_STATUS } from '../../constants/http'
import { SupportTicketModel } from '../admin/models/support-ticket.model'
import { UserModel } from '../user/user.model'
import { AppError } from '../../utils/AppError'

function toPublicTicket(ticket: {
  _id: { toString(): string }
  userId: { toString(): string }
  subject: string
  status: string
  priority: string
  messages?: Array<{
    _id?: { toString(): string }
    authorId: { toString(): string }
    authorName?: string
    body: string
    isStaff?: boolean
    createdAt?: Date
  }>
  createdAt: Date
  updatedAt: Date
}) {
  return {
    id: ticket._id.toString(),
    userId: ticket.userId.toString(),
    subject: ticket.subject,
    status: ticket.status,
    priority: ticket.priority,
    messages: (ticket.messages ?? []).map((m) => ({
      id: m._id?.toString?.() ?? '',
      authorId: m.authorId.toString(),
      authorName: m.authorName || '',
      body: m.body,
      isStaff: Boolean(m.isStaff),
      createdAt: m.createdAt?.toISOString?.() ?? new Date().toISOString(),
    })),
    createdAt: ticket.createdAt.toISOString(),
    updatedAt: ticket.updatedAt.toISOString(),
  }
}

export const supportService = {
  async listMine(userId: string) {
    const items = await SupportTicketModel.find({ userId })
      .sort({ updatedAt: -1 })
      .limit(50)
      .lean()
    return { items: items.map(toPublicTicket) }
  },

  async getMine(userId: string, id: string) {
    if (!Types.ObjectId.isValid(id)) {
      throw new AppError('Ticket not found.', HTTP_STATUS.NOT_FOUND)
    }
    const ticket = await SupportTicketModel.findOne({ _id: id, userId }).lean()
    if (!ticket) throw new AppError('Ticket not found.', HTTP_STATUS.NOT_FOUND)
    return { ticket: toPublicTicket(ticket) }
  },

  async create(
    userId: string,
    input: { subject: string; body: string; priority?: string },
  ) {
    const user = await UserModel.findById(userId).select('name').lean()
    if (!user) throw new AppError('Not signed in.', HTTP_STATUS.UNAUTHORIZED)

    const ticket = await SupportTicketModel.create({
      userId,
      subject: input.subject.trim(),
      priority: input.priority || 'normal',
      status: 'open',
      messages: [
        {
          authorId: userId,
          authorName: user.name,
          body: input.body.trim(),
          isStaff: false,
          createdAt: new Date(),
        },
      ],
    })

    return { ticket: toPublicTicket(ticket) }
  },

  async reply(userId: string, id: string, body: string) {
    if (!Types.ObjectId.isValid(id)) {
      throw new AppError('Ticket not found.', HTTP_STATUS.NOT_FOUND)
    }
    const ticket = await SupportTicketModel.findOne({ _id: id, userId })
    if (!ticket) throw new AppError('Ticket not found.', HTTP_STATUS.NOT_FOUND)
    if (ticket.status === 'closed') {
      throw new AppError(
        'This ticket is closed. Open a new one.',
        HTTP_STATUS.BAD_REQUEST,
      )
    }

    const user = await UserModel.findById(userId).select('name').lean()
    ticket.messages.push({
      authorId: new Types.ObjectId(userId),
      authorName: user?.name ?? 'You',
      body: body.trim(),
      isStaff: false,
      createdAt: new Date(),
    } as never)
    if (ticket.status === 'resolved') ticket.status = 'open'
    else if (ticket.status === 'waiting') ticket.status = 'open'
    await ticket.save()
    return { ticket: toPublicTicket(ticket) }
  },
}
