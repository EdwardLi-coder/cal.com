import { CreateBookingInput } from "@/ee/bookings/inputs/create-booking.input";
import { CreateRecurringBookingInput } from "@/ee/bookings/inputs/create-recurring-booking.input";
import { MarkNoShowInput } from "@/ee/bookings/inputs/mark-no-show.input";
import { GetBookingOutput } from "@/ee/bookings/outputs/get-booking.output";
import { GetBookingsOutput } from "@/ee/bookings/outputs/get-bookings.output";
import { MarkNoShowOutput } from "@/ee/bookings/outputs/mark-no-show.output";
import { hashAPIKey, isApiKey, stripApiKey } from "@/lib/api-key";
import { API_VERSIONS_VALUES } from "@/lib/api-versions";
import { ApiKeyRepository } from "@/modules/api-key/api-key-repository";
import { GetUser } from "@/modules/auth/decorators/get-user/get-user.decorator";
import { Permissions } from "@/modules/auth/decorators/permissions/permissions.decorator";
import { ApiAuthGuard } from "@/modules/auth/guards/api-auth/api-auth.guard";
import { PermissionsGuard } from "@/modules/auth/guards/permissions/permissions.guard";
import { BillingService } from "@/modules/billing/services/billing.service";
import { OAuthClientRepository } from "@/modules/oauth-clients/oauth-client.repository";
import { OAuthFlowService } from "@/modules/oauth-clients/services/oauth-flow.service";
import { PrismaReadService } from "@/modules/prisma/prisma-read.service";
import {
  Controller,
  Post,
  Logger,
  Req,
  InternalServerErrorException,
  Body,
  Headers,
  HttpException,
  Param,
  Get,
  Query,
  NotFoundException,
  UseGuards,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ApiQuery, ApiTags as DocsTags } from "@nestjs/swagger";
import { User } from "@prisma/client";
import { Request } from "express";
import { NextApiRequest } from "next/types";

import { X_CAL_CLIENT_ID } from "@calcom/platform-constants";
import { BOOKING_READ, SUCCESS_STATUS, BOOKING_WRITE } from "@calcom/platform-constants";
import {
  handleNewBooking,
  BookingResponse,
  HttpError,
  handleNewRecurringBooking,
  handleInstantMeeting,
  handleMarkNoShow,
  getAllUserBookings,
  getBookingInfo,
  handleCancelBooking,
  getBookingForReschedule,
} from "@calcom/platform-libraries";
import { GetBookingsInput, CancelBookingInput, Status } from "@calcom/platform-types";
import { ApiResponse } from "@calcom/platform-types";
import { PrismaClient } from "@calcom/prisma";

type BookingRequest = Request & {
  userId?: number;
};

type OAuthRequestParams = {
  platformClientId: string;
  platformRescheduleUrl: string;
  platformCancelUrl: string;
  platformBookingUrl: string;
  platformBookingLocation?: string;
  arePlatformEmailsEnabled: boolean;
};

const DEFAULT_PLATFORM_PARAMS = {
  platformClientId: "",
  platformCancelUrl: "",
  platformRescheduleUrl: "",
  platformBookingUrl: "",
  arePlatformEmailsEnabled: false,
  platformBookingLocation: undefined,
};

@Controller({
  path: "/v2/bookings",
  version: API_VERSIONS_VALUES,
})
@UseGuards(PermissionsGuard)
@DocsTags("Bookings")
export class BookingsController {
  private readonly logger = new Logger("BookingsController");

  constructor(
    private readonly oAuthFlowService: OAuthFlowService,
    private readonly prismaReadService: PrismaReadService,
    private readonly oAuthClientRepository: OAuthClientRepository,
    private readonly billingService: BillingService,
    private readonly config: ConfigService,
    private readonly apiKeyRepository: ApiKeyRepository
  ) {}

  @Get("/")
  @UseGuards(ApiAuthGuard)
  @Permissions([BOOKING_READ])
  @ApiQuery({ name: "filters[status]", enum: Status, required: true })
  @ApiQuery({ name: "limit", type: "number", required: false })
  @ApiQuery({ name: "cursor", type: "number", required: false })
  async getBookings(
    @GetUser() user: User,
    @Query() queryParams: GetBookingsInput
  ): Promise<GetBookingsOutput> {
    const { filters, cursor, limit } = queryParams;
    const bookings = await getAllUserBookings({
      bookingListingByStatus: filters.status,
      skip: cursor ?? 0,
      take: limit ?? 10,
      filters,
      ctx: {
        user: { email: user.email, id: user.id },
        prisma: this.prismaReadService.prisma as unknown as PrismaClient,
      },
    });

    return {
      status: SUCCESS_STATUS,
      data: bookings,
    };
  }

  @Get("/:bookingUid")
  async getBooking(@Param("bookingUid") bookingUid: string): Promise<GetBookingOutput> {
    const { bookingInfo } = await getBookingInfo(bookingUid);

    if (!bookingInfo) {
      throw new NotFoundException(`Booking with UID=${bookingUid} does not exist.`);
    }

    return {
      status: SUCCESS_STATUS,
      data: bookingInfo,
    };
  }

  @Get("/:bookingUid/reschedule")
  async getBookingForReschedule(@Param("bookingUid") bookingUid: string): Promise<ApiResponse<unknown>> {
    const booking = await getBookingForReschedule(bookingUid);

    if (!booking) {
      throw new NotFoundException(`Booking with UID=${bookingUid} does not exist.`);
    }

    return {
      status: SUCCESS_STATUS,
      data: booking,
    };
  }

  @Post("/")
  async createBooking(
    @Req() req: BookingRequest,
    @Body() body: CreateBookingInput,
    @Headers(X_CAL_CLIENT_ID) clientId?: string
  ): Promise<ApiResponse<Partial<BookingResponse>>> {
    const oAuthClientId = clientId?.toString();
    const { orgSlug, locationUrl } = body;
    req.headers["x-cal-force-slug"] = orgSlug;
    try {
      const booking = await handleNewBooking(
        await this.createNextApiBookingRequest(req, oAuthClientId, locationUrl)
      );
      if (booking.userId && booking.uid && booking.startTime) {
        void (await this.billingService.increaseUsageByUserId(booking.userId, {
          uid: booking.uid,
          startTime: booking.startTime,
          fromReschedule: booking.fromReschedule,
        }));
      }
      return {
        status: SUCCESS_STATUS,
        data: booking,
      };
    } catch (err) {
      this.handleBookingErrors(err);
    }
    throw new InternalServerErrorException("Could not create booking.");
  }

  @Post("/:bookingId/cancel")
  async cancelBooking(
    @Req() req: BookingRequest,
    @Param("bookingId") bookingId: string,
    @Body() _: CancelBookingInput,
    @Headers(X_CAL_CLIENT_ID) clientId?: string
  ): Promise<ApiResponse<{ bookingId: number; bookingUid: string; onlyRemovedAttendee: boolean }>> {
    const oAuthClientId = clientId?.toString();
    if (bookingId) {
      try {
        req.body.id = parseInt(bookingId);
        const res = await handleCancelBooking(await this.createNextApiBookingRequest(req, oAuthClientId));
        if (!res.onlyRemovedAttendee) {
          void (await this.billingService.cancelUsageByBookingUid(res.bookingUid));
        }
        return {
          status: SUCCESS_STATUS,
          data: {
            bookingId: res.bookingId,
            bookingUid: res.bookingUid,
            onlyRemovedAttendee: res.onlyRemovedAttendee,
          },
        };
      } catch (err) {
        this.handleBookingErrors(err);
      }
    } else {
      throw new NotFoundException("Booking ID is required.");
    }
    throw new InternalServerErrorException("Could not cancel booking.");
  }

  @Post("/:bookingUid/mark-no-show")
  @Permissions([BOOKING_WRITE])
  @UseGuards(ApiAuthGuard)
  async markNoShow(
    @GetUser("id") userId: number,
    @Body() body: MarkNoShowInput,
    @Param("bookingUid") bookingUid: string
  ): Promise<MarkNoShowOutput> {
    try {
      const markNoShowResponse = await handleMarkNoShow({
        bookingUid: bookingUid,
        attendees: body.attendees,
        noShowHost: body.noShowHost,
        userId,
      });

      return { status: SUCCESS_STATUS, data: markNoShowResponse };
    } catch (err) {
      this.handleBookingErrors(err, "no-show");
    }
    throw new InternalServerErrorException("Could not mark no show.");
  }

  @Post("/recurring")
  async createRecurringBooking(
    @Req() req: BookingRequest,
    @Body() _: CreateRecurringBookingInput[],
    @Headers(X_CAL_CLIENT_ID) clientId?: string
  ): Promise<ApiResponse<BookingResponse[]>> {
    const oAuthClientId = clientId?.toString();
    try {
      const createdBookings: BookingResponse[] = await handleNewRecurringBooking(
        await this.createNextApiBookingRequest(req, oAuthClientId)
      );

      createdBookings.forEach(async (booking) => {
        if (booking.userId && booking.uid && booking.startTime) {
          void (await this.billingService.increaseUsageByUserId(booking.userId, {
            uid: booking.uid,
            startTime: booking.startTime,
          }));
        }
      });

      return {
        status: SUCCESS_STATUS,
        data: createdBookings,
      };
    } catch (err) {
      this.handleBookingErrors(err, "recurring");
    }
    throw new InternalServerErrorException("Could not create recurring booking.");
  }

  @Post("/instant")
  async createInstantBooking(
    @Req() req: BookingRequest,
    @Body() _: CreateBookingInput,
    @Headers(X_CAL_CLIENT_ID) clientId?: string
  ): Promise<ApiResponse<Awaited<ReturnType<typeof handleInstantMeeting>>>> {
    const oAuthClientId = clientId?.toString();
    req.userId = (await this.getOwnerId(req)) ?? -1;
    try {
      const instantMeeting = await handleInstantMeeting(
        await this.createNextApiBookingRequest(req, oAuthClientId)
      );

      if (instantMeeting.userId && instantMeeting.bookingUid) {
        const now = new Date();
        // add a 10 secondes delay to the usage incrementation to give some time to cancel the booking if needed
        now.setSeconds(now.getSeconds() + 10);
        void (await this.billingService.increaseUsageByUserId(instantMeeting.userId, {
          uid: instantMeeting.bookingUid,
          startTime: now,
        }));
      }

      return {
        status: SUCCESS_STATUS,
        data: instantMeeting,
      };
    } catch (err) {
      this.handleBookingErrors(err, "instant");
    }
    throw new InternalServerErrorException("Could not create instant booking.");
  }

  private async getOwnerId(req: Request): Promise<number | undefined> {
    try {
      const bearerToken = req.get("Authorization")?.replace("Bearer ", "");
      if (bearerToken) {
        if (isApiKey(bearerToken, this.config.get<string>("api.apiKeyPrefix") ?? "cal_")) {
          const strippedApiKey = stripApiKey(bearerToken, this.config.get<string>("api.keyPrefix"));
          const apiKeyHash = hashAPIKey(strippedApiKey);
          const keyData = await this.apiKeyRepository.getApiKeyFromHash(apiKeyHash);
          return keyData?.userId;
        } else {
          // Access Token
          return this.oAuthFlowService.getOwnerId(bearerToken);
        }
      }
    } catch (err) {
      this.logger.error(err);
    }
  }

  private async getOAuthClientsParams(clientId: string): Promise<OAuthRequestParams> {
    const res = DEFAULT_PLATFORM_PARAMS;
    try {
      const client = await this.oAuthClientRepository.getOAuthClient(clientId);
      // fetch oAuthClient from db and use data stored in db to set these values
      if (client) {
        res.platformClientId = clientId;
        res.platformCancelUrl = client.bookingCancelRedirectUri ?? "";
        res.platformRescheduleUrl = client.bookingRescheduleRedirectUri ?? "";
        res.platformBookingUrl = client.bookingRedirectUri ?? "";
        res.arePlatformEmailsEnabled = client.areEmailsEnabled ?? false;
      }
      return res;
    } catch (err) {
      this.logger.error(err);
      return res;
    }
  }

  private async createNextApiBookingRequest(
    req: BookingRequest,
    oAuthClientId?: string,
    platformBookingLocation?: string
  ): Promise<NextApiRequest & { userId?: number } & OAuthRequestParams> {
    const userId = (await this.getOwnerId(req)) ?? -1;
    const oAuthParams = oAuthClientId
      ? await this.getOAuthClientsParams(oAuthClientId)
      : DEFAULT_PLATFORM_PARAMS;
    Object.assign(req, { userId, ...oAuthParams, platformBookingLocation });
    req.body = { ...req.body, noEmail: !oAuthParams.arePlatformEmailsEnabled };
    return req as unknown as NextApiRequest & { userId?: number } & OAuthRequestParams;
  }

  private handleBookingErrors(
    err: Error | HttpError | unknown,
    type?: "recurring" | `instant` | "no-show"
  ): void {
    const errMsg =
      type === "no-show"
        ? `Error while marking no-show.`
        : `Error while creating ${type ? type + " " : ""}booking.`;
    if (err instanceof HttpError) {
      const httpError = err as HttpError;
      throw new HttpException(httpError?.message ?? errMsg, httpError?.statusCode ?? 500);
    }

    if (err instanceof Error) {
      const error = err as Error;
      throw new InternalServerErrorException(error?.message ?? errMsg);
    }

    throw new InternalServerErrorException(errMsg);
  }
}
