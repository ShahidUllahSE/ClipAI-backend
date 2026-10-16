import { Types } from 'mongoose'
import { HTTP_STATUS } from '../../constants/http'
import { AppError } from '../../utils/AppError'
import { UserModel } from '../user/user.model'
import { logAdminActivity } from './admin.activity'
import {
  SupportTicketModel,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
} from './models/support-ticket.model'
import { EmailTemplateModel } from './models/email-template.model'

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
  assignedTo?: { toString(): string } | null
  createdAt: Date
  updatedAt: Date
}) {
  return {
    id: ticket._id.toString(),
    userId: ticket.userId.toString(),
    subject: ticket.subject,
    status: ticket.status,
    priority: ticket.priority,
    assignedTo: ticket.assignedTo ? ticket.assignedTo.toString() : null,
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

function toPublicTemplate(template: {
  _id: { toString(): string }
  slug: string
  name: string
  subject: string
  body: string
  isActive: boolean
  createdAt: Date
  updatedAt: Date
}) {
  return {
    id: template._id.toString(),
    slug: template.slug,
    name: template.name,
    subject: template.subject,
    body: template.body,
    isActive: template.isActive,
    createdAt: template.createdAt.toISOString(),
    updatedAt: template.updatedAt.toISOString(),
  }
}

export const adminSupportService = {
  async listTickets(input: {
    page: number
    limit: number
    status?: (typeof TICKET_STATUSES)[number]
    priority?: (typeof TICKET_PRIORITIES)[number]
    q?: string
  }) {
    const filter: Record<string, unknown> = {}
    if (input.status) filter.status = input.status
    if (input.priority) filter.priority = input.priority
    if (input.q) {
      filter.subject = { $regex: input.q, $options: 'i' }
    }

    const skip = (input.page - 1) * input.limit
    const [items, total] = await Promise.all([
      SupportTicketModel.find(filter)
        .sort({ updatedAt: -1 })
        .skip(skip)
        .limit(input.limit)
        .lean(),
      SupportTicketModel.countDocuments(filter),
    ])

    const userIds = [...new Set(items.map((t) => t.userId.toString()))]
    const users = userIds.length
      ? await UserModel.find({ _id: { $in: userIds } })
          .select('name email')
          .lean()
      : []
    const userById = new Map(users.map((u) => [u._id.toString(), u]))

    return {
      items: items.map((ticket) => {
        const owner = userById.get(ticket.userId.toString())
        return {
          ...toPublicTicket(ticket),
          userName: owner?.name ?? 'Unknown',
          userEmail: owner?.email ?? '',
        }
      }),
      pagination: {
        page: input.page,
        limit: input.limit,
        total,
        pages: Math.max(1, Math.ceil(total / input.limit)),
      },
    }
  },

  async getTicket(id: string) {
    if (!Types.ObjectId.isValid(id)) {
      throw new AppError('Ticket not found.', HTTP_STATUS.NOT_FOUND)
    }
    const ticket = await SupportTicketModel.findById(id).lean()
    if (!ticket) throw new AppError('Ticket not found.', HTTP_STATUS.NOT_FOUND)
    const owner = await UserModel.findById(ticket.userId)
      .select('name email')
      .lean()
    return {
      ticket: {
        ...toPublicTicket(ticket),
        userName: owner?.name ?? 'Unknown',
        userEmail: owner?.email ?? '',
      },
    }
  },

  async createTicket(
    actorId: string,
    input: {
      userId: string
      subject: string
      body: string
      priority?: (typeof TICKET_PRIORITIES)[number]
    },
  ) {
    if (!Types.ObjectId.isValid(input.userId)) {
      throw new AppError('User not found.', HTTP_STATUS.NOT_FOUND)
    }
    const user = await UserModel.findById(input.userId).lean()
    if (!user) throw new AppError('User not found.', HTTP_STATUS.NOT_FOUND)
    const actor = await UserModel.findById(actorId).select('name').lean()

    const ticket = await SupportTicketModel.create({
      userId: input.userId,
      subject: input.subject.trim(),
      priority: input.priority ?? 'normal',
      status: 'open',
      messages: [
        {
          authorId: actorId,
          authorName: actor?.name ?? 'Admin',
          body: input.body.trim(),
          isStaff: true,
          createdAt: new Date(),
        },
      ],
      assignedTo: actorId,
    })

    await logAdminActivity({
      actorId,
      action: 'ticket.create',
      targetType: 'ticket',
      targetId: ticket._id.toString(),
      summary: `Opened ticket: ${ticket.subject}`,
    })

    return { ticket: toPublicTicket(ticket) }
  },

  async replyTicket(
    actorId: string,
    id: string,
    input: { body: string; status?: (typeof TICKET_STATUSES)[number] },
  ) {
    if (!Types.ObjectId.isValid(id)) {
      throw new AppError('Ticket not found.', HTTP_STATUS.NOT_FOUND)
    }
    const ticket = await SupportTicketModel.findById(id)
    if (!ticket) throw new AppError('Ticket not found.', HTTP_STATUS.NOT_FOUND)
    const actor = await UserModel.findById(actorId).select('name').lean()

    ticket.messages.push({
      authorId: new Types.ObjectId(actorId),
      authorName: actor?.name ?? 'Admin',
      body: input.body.trim(),
      isStaff: true,
      createdAt: new Date(),
    } as never)

    if (input.status) ticket.status = input.status
    else if (ticket.status === 'open') ticket.status = 'in_progress'
    ticket.assignedTo = new Types.ObjectId(actorId)
    await ticket.save()

    await logAdminActivity({
      actorId,
      action: 'ticket.reply',
      targetType: 'ticket',
      targetId: id,
      summary: `Replied to ticket: ${ticket.subject}`,
    })

    return { ticket: toPublicTicket(ticket) }
  },

  async updateTicket(
    actorId: string,
    id: string,
    input: {
      status?: (typeof TICKET_STATUSES)[number]
      priority?: (typeof TICKET_PRIORITIES)[number]
    },
  ) {
    if (!Types.ObjectId.isValid(id)) {
      throw new AppError('Ticket not found.', HTTP_STATUS.NOT_FOUND)
    }
    const ticket = await SupportTicketModel.findById(id)
    if (!ticket) throw new AppError('Ticket not found.', HTTP_STATUS.NOT_FOUND)
    if (input.status) ticket.status = input.status
    if (input.priority) ticket.priority = input.priority
    await ticket.save()
    await logAdminActivity({
      actorId,
      action: 'ticket.update',
      targetType: 'ticket',
      targetId: id,
      summary: `Updated ticket ${ticket.subject}`,
      meta: input,
    })
    return { ticket: toPublicTicket(ticket) }
  },

  async listTemplates() {
    const templates = await EmailTemplateModel.find()
      .sort({ name: 1 })
      .lean()
    return { templates: templates.map(toPublicTemplate) }
  },

  async createTemplate(
    actorId: string,
    input: {
      slug: string
      name: string
      subject: string
      body: string
      isActive?: boolean
    },
  ) {
    const slug = input.slug.trim().toLowerCase()
    const exists = await EmailTemplateModel.findOne({ slug }).lean()
    if (exists) {
      throw new AppError('Template slug already exists.', HTTP_STATUS.CONFLICT)
    }
    const template = await EmailTemplateModel.create({
      slug,
      name: input.name.trim(),
      subject: input.subject.trim(),
      body: input.body,
      isActive: input.isActive ?? true,
    })
    await logAdminActivity({
      actorId,
      action: 'template.create',
      targetType: 'email_template',
      targetId: template._id.toString(),
      summary: `Created template ${slug}`,
    })
    return { template: toPublicTemplate(template) }
  },

  async updateTemplate(
    actorId: string,
    id: string,
    input: Partial<{
      name: string
      subject: string
      body: string
      isActive: boolean
    }>,
  ) {
    if (!Types.ObjectId.isValid(id)) {
      throw new AppError('Template not found.', HTTP_STATUS.NOT_FOUND)
    }
    const template = await EmailTemplateModel.findById(id)
    if (!template) {
      throw new AppError('Template not found.', HTTP_STATUS.NOT_FOUND)
    }
    if (input.name !== undefined) template.name = input.name.trim()
    if (input.subject !== undefined) template.subject = input.subject.trim()
    if (input.body !== undefined) template.body = input.body
    if (input.isActive !== undefined) template.isActive = input.isActive
    await template.save()
    await logAdminActivity({
      actorId,
      action: 'template.update',
      targetType: 'email_template',
      targetId: id,
      summary: `Updated template ${template.slug}`,
    })
    return { template: toPublicTemplate(template) }
  },

  async deleteTemplate(actorId: string, id: string) {
    if (!Types.ObjectId.isValid(id)) {
      throw new AppError('Template not found.', HTTP_STATUS.NOT_FOUND)
    }
    const template = await EmailTemplateModel.findById(id)
    if (!template) {
      throw new AppError('Template not found.', HTTP_STATUS.NOT_FOUND)
    }
    await template.deleteOne()
    await logAdminActivity({
      actorId,
      action: 'template.delete',
      targetType: 'email_template',
      targetId: id,
      summary: `Deleted template ${template.slug}`,
    })
    return { message: 'Template deleted.' }
  },
}
