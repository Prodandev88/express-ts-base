/* eslint-disable no-param-reassign */
/* eslint-disable class-methods-use-this */
/* eslint-disable no-useless-constructor */
import { Request } from 'express';
import CoreService from '@src/core/module/core.service';
import { ICoreQueryParams } from '@src/utils/constants/interface';
import { BadRequestHTTP, NotFoundHTTP } from '@src/configs/httpException';
import bcrypt from 'bcryptjs';
import moment from 'moment';
import { i18nKey } from '@src/configs/i18n/init.i18n';
import UserModel, { IUserModel } from '@src/configs/database/models/user.model';
import { Op } from 'sequelize';
import { getCache } from '@src/configs/database/redis/cache';
import jwt, { IJwtPayload } from '../../utils/jwt';
import { generateOTP } from '../../utils/functions';
import { ICreateUserDto, IForgotPasswordDto, ILoginDto } from './auth.interface';

class AuthService extends CoreService {
  private readonly userModel = UserModel;

  protected readonly params: ICoreQueryParams = {
    searchFields: [],
    sortFields: [],
    filterFields: [],
    dateScope: [],
    embed: {},
  };

  constructor() {
    super();
  }

  async register(dto: ICreateUserDto) {
    const { username = '', email = '' } = dto;

    const existedUser = await this.userModel.findOne({
      where: { [Op.or]: [{ username }, { email }] },
    });
    if (existedUser) throw new BadRequestHTTP(i18nKey.auth.userExisted);

    const user = await this.userModel.create(dto);
    const tokenPayload = { id: user.id, email: user.email, username: user.username };
    const tokens = jwt.sign(tokenPayload);

    return { user, tokens };
  }

  async login(dto: ILoginDto) {
    const { username = '', email = '', password } = dto;

    const user = await this.userModel.findOne({
      where: { [Op.or]: [{ username }, { email }] },
      attributes: ['id', 'email', 'username', 'first_name', 'last_name', 'password'],
    });
    if (!user) throw new NotFoundHTTP(i18nKey.auth.userNotFound);

    const { password: pws, ...restUser } = user.toJSON();

    const isMatch = bcrypt.compareSync(password, pws);
    if (!isMatch) throw new BadRequestHTTP(i18nKey.auth.loginFailed);

    const tokenPayload = { id: user.id, email: user.email, username: user.username };
    const tokens = jwt.sign(tokenPayload);
    // TODO: Save refresh token

    return { user: restUser, tokens };
  }

  async forgotPassword(dto: IForgotPasswordDto) {
    const { email = '', username = '' } = dto;
    const user = await this.userModel.findOne({ where: { [Op.or]: [{ username }, { email }] } });
    if (!user) throw new NotFoundHTTP(i18nKey.auth.userNotFound);

    const otp = generateOTP();
    const expireMinutes = Number(process.env.OTP_EXPIRES_TIME || 5);
    const expires = moment().add(expireMinutes, 'minutes').toDate();

    await this.setForgotPasswordData(user.id, { otp, expires });

    return { otp, expires, email };
  }

  async resetPassword(req: Request) {
    const { username = '', email = '', otp, newPassword } = req.body;

    const user = await this.userModel.findOne({ where: { [Op.or]: [{ username }, { email }] } });
    if (!user) throw new NotFoundHTTP(i18nKey.auth.userNotFound);

    this.compareOtp(user, otp);
    await this.setResetPasswordData(user.id, { password: newPassword });

    return true;
  }

  async refreshAccessToken(refreshToken: string) {
    const payload = jwt.verifyRefreshToken(refreshToken) as IJwtPayload;
    const redisSessionKey = `session:${payload.id}`;
    const session = await getCache(redisSessionKey);
    if (!session) throw new BadRequestHTTP(i18nKey.auth.tokenExpired);
    const user = await this.userModel.findOne({ where: { id: payload.id } });
    if (!user) throw new BadRequestHTTP(i18nKey.auth.invalidToken);

    const tokenPayload = { id: user.id, email: user.email, username: user.username };
    const accessToken = jwt.signAccessToken(tokenPayload);
    return accessToken;
  }

  // #region private methods
  private compareOtp(user: IUserModel, otp: string) {
    if (!user.reset_password) throw new BadRequestHTTP(i18nKey.auth.otpNotMatch);

    const isMatchOtp = user.forgot_password_code === otp;
    if (!isMatchOtp) throw new BadRequestHTTP(i18nKey.auth.otpNotMatch);

    const expireDate = user.forgot_password_code_expires && moment(user.forgot_password_code_expires);
    if (!expireDate || moment().isAfter(expireDate)) throw new BadRequestHTTP(i18nKey.auth.otpExpired);

    return true;
  }

  private async setForgotPasswordData(userId: string, { otp, expires }: { otp: string; expires: Date }) {
    return await this.userModel.update(
      {
        forgot_password_code: otp,
        forgot_password_code_expires: expires,
        reset_password: true,
      },
      { where: { id: userId } }
    );
  }

  private async setResetPasswordData(userId: string, { password }: { password: string }) {
    return await this.userModel.update(
      {
        forgot_password_code: undefined,
        forgot_password_code_expires: undefined,
        reset_password: false,
        password,
      },
      { where: { id: userId } }
    );
  }

  // #endregion
}

export default new AuthService();
