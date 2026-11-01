import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  notFound,
  toTemplateResource,
  type TemplateInput,
} from './bulk-messages.types';

// Messages saved to reuse in bulk sends. A send copies the text when it
// starts, so editing or deleting a template never changes one under way.
@Injectable()
export class MessageTemplatesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string) {
    const rows = await this.prisma.messageTemplate.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toTemplateResource);
  }

  async create(userId: string, input: TemplateInput) {
    const row = await this.prisma.messageTemplate.create({
      data: { userId, name: input.name!, body: input.body! },
    });
    return toTemplateResource(row);
  }

  async update(userId: string, id: string, input: TemplateInput) {
    const { count } = await this.prisma.messageTemplate.updateMany({
      where: { id, userId },
      data: input,
    });
    if (!count) throw notFound('template');
    const row = await this.prisma.messageTemplate.findUniqueOrThrow({
      where: { id },
    });
    return toTemplateResource(row);
  }

  async remove(userId: string, id: string) {
    const { count } = await this.prisma.messageTemplate.deleteMany({
      where: { id, userId },
    });
    if (!count) throw notFound('template');
  }
}
