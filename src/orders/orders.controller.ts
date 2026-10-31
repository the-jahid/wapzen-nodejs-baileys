import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { User } from '../generated/prisma/client';
import { ClerkAuthGuard, CurrentUser } from '../auth/auth.guard';
import { validationFailed } from '../tools/tools.types';
import { OrdersService } from './orders.service';
import {
  LIST_PATH,
  parseFilter,
  parseListQuery,
  parseUpdate,
} from './orders.types';

// /v1/dashboard/orders is what the dashboard calls with its Clerk session;
// /v1/orders is the public path documented in docs/openapi.json. Both share
// these handlers. Orders are only created by an agent, so there is no POST.
@ApiExcludeController()
@UseGuards(ClerkAuthGuard)
@Controller(['v1/orders', 'v1/dashboard/orders'])
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get()
  async list(
    @CurrentUser() user: User,
    @Query() query: Record<string, string | undefined>,
  ) {
    const { page, limit, filter } = parseListQuery(query);
    const { orders, total, newOrders } = await this.orders.list(
      user.id,
      filter,
      page,
      limit,
    );
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const at = (p: number) => `${LIST_PATH}?page=${p}&limit=${limit}`;
    return {
      success: true,
      message: 'Orders retrieved successfully',
      data: orders,
      meta: {
        new_orders: newOrders,
        pagination: {
          page,
          limit,
          total_items: total,
          total_pages: totalPages,
          has_next_page: page < totalPages,
          has_previous_page: page > 1,
        },
      },
      links: {
        self: at(page),
        first: at(1),
        previous: page > 1 ? at(page - 1) : null,
        next: page < totalPages ? at(page + 1) : null,
        last: at(totalPages),
      },
    };
  }

  // Declared before :order_id, which would otherwise match "export".
  @Get('export')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="orders.csv"')
  async export(
    @CurrentUser() user: User,
    @Query() query: Record<string, string | undefined>,
  ) {
    const { filter, errors } = parseFilter(query);
    if (errors.length)
      throw validationFailed(errors, 'Invalid query parameters');
    return this.orders.exportCsv(user.id, filter);
  }

  @Get(':order_id')
  async get(@CurrentUser() user: User, @Param('order_id') id: string) {
    return {
      success: true,
      message: 'Order retrieved successfully',
      data: await this.orders.get(user.id, id.trim()),
    };
  }

  @Patch(':order_id')
  async update(
    @CurrentUser() user: User,
    @Param('order_id') id: string,
    @Body() body: unknown,
  ) {
    const update = parseUpdate(body);
    return {
      success: true,
      message: 'Order updated successfully',
      data: await this.orders.update(user.id, id.trim(), update),
    };
  }

  @Delete(':order_id')
  @HttpCode(200)
  async remove(@CurrentUser() user: User, @Param('order_id') id: string) {
    id = id.trim();
    await this.orders.remove(user.id, id);
    return {
      success: true,
      message: 'Order deleted successfully',
      data: { id, deleted: true },
    };
  }
}
